import { db, repositories, codeChunks, codeFiles, and, eq, notInArray, cosineDistance, asc, sql } from "@codeguard/db";
import { publish, repoKey, TOPICS, RepoIndexRequested } from "@codeguard/kafka";
import {
  addedLines,
  assessRisk,
  blastRadius,
  changedSymbols,
  fanIn,
  findCallers,
  isIgnored,
  parsePolicy,
  type DiffFile,
  type Embedder,
  type ReviewContext,
} from "@codeguard/review-engine";
import { fetchFileAtRef } from "@codeguard/review-engine/github";
import type { Octokit } from "octokit";

/**
 * Gather everything the reviewers should see BEYOND the diff (Day 3.1–3.2):
 *   policy (.codeguard.yml from the BASE commit) · blast radius · callers · related code (RAG) · risk
 * Every piece is best effort: a missing index or a GitHub hiccup gives a review
 * with less context, never a failed review.
 */
const MAX_CALLER_FILES = 10;
const RAG_LIMIT = 8;
const RAG_MAX_DISTANCE = 0.6; // cosine distance (1 − similarity). Unrelated code measured ~0.73, related ~0.47

export async function buildReviewContext(input: {
  octokit: Octokit;
  embedder: Embedder;
  owner: string;
  repo: string;
  repoFullName: string;
  installationId: number;
  baseSha: string;
  headSha: string;
  files: DiffFile[];
}): Promise<{ context: ReviewContext; files: DiffFile[] }> {
  const { octokit, owner, repo } = input;

  // Policy from the BASE commit: a PR must not be able to relax its own rules.
  const policyText = await fetchFileAtRef(octokit, owner, repo, ".codeguard.yml", input.baseSha).catch(() => null);
  const { policy, warnings } = parsePolicy(policyText);
  const files = input.files.filter((f) => !isIgnored(f.filename, policy));
  const changed = files.filter((f) => f.status !== "removed").map((f) => f.filename);

  // HEAD versions of changed files: for callers, ESLint and the verifier's code windows.
  const headContents = new Map<string, string>();
  await Promise.all(
    files
      .filter((f) => f.status !== "removed" && f.patch)
      .slice(0, 30)
      .map(async (f) => {
        const c = await fetchFileAtRef(octokit, owner, repo, f.filename, input.headSha).catch(() => null);
        if (c !== null) headContents.set(f.filename, c);
      }),
  );

  const [repoRow] = await db.select().from(repositories).where(eq(repositories.fullName, input.repoFullName)).limit(1);
  let affected: ReviewContext["affected"] = [];
  let callers: ReviewContext["callers"] = [];
  let related: ReviewContext["related"] = [];
  let maxFanIn = 0;

  if (repoRow && !repoRow.indexedSha) {
    // Never indexed: ask for an index now so the NEXT review has full context.
    await publish(TOPICS.repoIndexRequested, repoKey(repoRow.id), RepoIndexRequested, {
      type: "repo.index.requested", repositoryId: repoRow.id, installationId: input.installationId, ref: null, reason: "review",
    }).catch(() => undefined);
  }

  if (repoRow?.indexedSha) {
    // ── Blast radius from the stored import graph ───────────────────────────
    const graph = await db.select({ path: codeFiles.path, imports: codeFiles.imports }).from(codeFiles).where(eq(codeFiles.repositoryId, repoRow.id));
    affected = blastRadius(changed, graph);
    maxFanIn = Math.max(0, ...changed.map((p) => fanIn(p, graph)));

    // ── Callers of changed functions, in the closest affected files ─────────
    const symbols = [...new Set(files.flatMap((f) => {
      const content = headContents.get(f.filename);
      return content ? changedSymbols(f.filename, content, addedLines(f.patch)) : [];
    }))];
    if (symbols.length) {
      const near = affected.filter((a) => a.distance === 1).slice(0, MAX_CALLER_FILES);
      const nearFiles = await Promise.all(
        near.map(async (a) => ({ path: a.path, content: (await fetchFileAtRef(octokit, owner, repo, a.path, input.headSha).catch(() => null)) ?? "" })),
      );
      callers = findCallers(symbols, nearFiles.filter((f) => f.content));
    }

    // ── RAG: code that MEANS something similar to the change ────────────────
    const query = files
      .map((f) => `// file: ${f.filename}\n${(f.patch ?? "").split("\n").filter((l) => l.startsWith("+")).join("\n")}`)
      .join("\n")
      .slice(0, 2000);
    if (query.trim()) {
      try {
        const [vec] = await input.embedder.embed([query]);
        const distance = cosineDistance(codeChunks.embedding, vec);
        related = await db
          .select({ path: codeChunks.path, symbol: codeChunks.symbol, startLine: codeChunks.startLine, endLine: codeChunks.endLine, content: codeChunks.content })
          .from(codeChunks)
          .where(and(
            eq(codeChunks.repositoryId, repoRow.id),
            changed.length ? notInArray(codeChunks.path, changed) : undefined, // the diff is already in the prompt
            sql`${distance} < ${RAG_MAX_DISTANCE}`,
          ))
          .orderBy(asc(distance))
          .limit(RAG_LIMIT);
      } catch (err) {
        console.warn("[context] RAG skipped:", (err as Error).message);
      }
    }
  }

  const risk = assessRisk({
    changedPaths: changed,
    affectedCount: affected.length,
    maxFanIn,
    linesChanged: files.reduce((n, f) => n + f.additions + f.deletions, 0),
    deletedTestFiles: input.files.filter((f) => f.status === "removed" && /(\.|_)(test|spec)\.|__tests__\//.test(f.filename)).length,
  });

  return { context: { policy, policyWarnings: warnings, related, callers, affected, risk, headContents }, files };
}
