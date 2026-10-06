import { MissingConfigError } from "@codeguard/config";
import { db, codeChunks, eq, and, or, inArray, notInArray, ilike } from "@codeguard/db";
import {
  ImportResolver,
  IntentSchema,
  StructuredLLM,
  annotatePatch,
  buildContextPacks,
  buildIntentMessages,
  changedLineSet,
  classifyFile,
  createIgnoreMatcher,
  createLLMProvider,
  detectTechnology,
  manifestPathsToFetch,
  resolveSkills,
  scanRiskyPatterns,
  scanSecrets,
  addedLines,
} from "@codeguard/review-engine";
import type { PipelineStep } from "@codeguard/review-engine";
import { getRepoOctokit } from "../../github/octokit.js";
import { PermanentError } from "../../queue/consumer.js";
import { EmbeddingService } from "../../ai/EmbeddingService.js";
import { RAGService } from "../../rag/RAGService.js";
import { DependencyGraph } from "../../analyzers/DependencyGraph.js";
import { ImportExtractor } from "../../analyzers/ImportExtractor.js";
import { astChunker } from "../../analyzers/ASTChunker.js";
import {
  fetchIssues,
  filesChangedSince,
  getFilesText,
  getTreePaths,
  listAllPRFiles,
  listChecks,
  listCommits,
  loadRepoConfig,
  referencedIssueNumbers,
} from "../github-data.js";
import { claimReview, countPriorPRs, failReview, lastCompletedReviewSha, takeReview, upsertPullRequest, upsertRepository } from "../store.js";
import type { ReviewRunState } from "../state.js";

type Step = PipelineStep<ReviewRunState>;

/** Upper bound on code chunks loaded for the dependency graph. */
const MAX_GRAPH_CHUNKS = 2_000;
/** Changed files whose head content is fetched (symbols + graph). */
const MAX_HEAD_FILES = 40;

// ─── initialize_run ──────────────────────────────────────────────────────────
/** Auth, model client, the PR itself and its repository/PR rows. */
export const initializeRun: Step = {
  name: "initialize_run",
  async run(s) {
    const { owner, repo, pullNumber } = s.event;
    try {
      s.llm = new StructuredLLM(createLLMProvider(), { warn: (m) => s.log.warn(m) });
    } catch (err) {
      // Retrying cannot fix missing configuration.
      if (err instanceof MissingConfigError) throw new PermanentError(err.message);
      throw err;
    }
    s.octokit = await getRepoOctokit(owner, repo, s.event.installationId);
    const { data: pr } = await s.octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    s.pr = pr;
    s.repositoryId = (await upsertRepository(pr, owner, repo)).id;
    s.pullRequestId = (await upsertPullRequest(pr, s.repositoryId)).id;
  },
};

// ─── validate_event ──────────────────────────────────────────────────────────
/**
 * Is this event still worth a review, and does this run own it?
 * Nothing is written to `reviews` unless the answer is yes.
 */
export const validateEvent: Step = {
  name: "validate_event",
  async run(s) {
    const { pr, event } = s;
    const stopWith = async (reason: string) => {
      s.stop = reason;
      // A dashboard user is waiting on this row — tell them why.
      if (event.reviewId) await failReview(event.reviewId, reason, { userMessage: reason }).catch(() => {});
    };

    if (pr.state !== "open") return stopWith("The pull request is not open.");
    if (pr.draft && event.triggeredBy === "webhook") return stopWith("Draft pull requests are not reviewed automatically.");
    if (event.headSha && pr.head.sha !== event.headSha && !event.reviewId) {
      // A newer push exists; its own event will review the latest commit.
      return stopWith("A newer commit was pushed; it will be reviewed instead.");
    }
    s.headSha = pr.head.sha;

    if (event.reviewId) {
      const row = await takeReview(event.reviewId);
      if (!row) {
        s.stop = "review already running or finished";
        return;
      }
      s.reviewId = row.id;
      if (row.headSha && row.headSha !== pr.head.sha) {
        return stopWith("The pull request changed while the review was queued. Start a new review for the latest commit.");
      }
    } else {
      s.reviewId = await claimReview({
        pullRequestId: s.pullRequestId,
        headSha: s.headSha,
        userId: event.userId,
        title: `PR #${pr.number}: ${pr.title}`,
        codeSnippet: `PR #${pr.number} diff (${pr.changed_files} files, +${pr.additions} -${pr.deletions})`,
        language: pr.base.repo.language ?? "code",
      });
      if (!s.reviewId) {
        s.stop = "a review for this commit already exists";
        return;
      }
    }

    // Incremental base = the last commit we actually reviewed (not GitHub's
    // `before`, which skips commits whose review was skipped or failed).
    if (event.triggeredBy === "webhook") {
      s.reviewBaseSha = await lastCompletedReviewSha(s.pullRequestId, s.headSha);
    }
    s.log = s.log.child({ reviewId: s.reviewId, headSha: s.headSha });
  },
};

// ─── snapshot_repository ─────────────────────────────────────────────────────
/** Config from the base commit; file tree and manifests from the head commit. */
export const snapshotRepository: Step = {
  name: "snapshot_repository",
  async run(s) {
    const { owner, repo } = s.event;
    s.config = await loadRepoConfig(s.octokit, owner, repo, s.pr.base.sha, s.log);
    try {
      const tree = await getTreePaths(s.octokit, owner, repo, s.headSha);
      s.treePaths = tree.paths;
      s.treeTruncated = tree.truncated;
      s.manifests = Object.fromEntries(await getFilesText(s.octokit, owner, repo, manifestPathsToFetch(tree.paths), s.headSha));
    } catch (err) {
      s.log.warn("repository snapshot unavailable", { error: (err as Error).message });
    }
  },
};

// ─── collect_pr_context ──────────────────────────────────────────────────────
export const collectPrContext: Step = {
  name: "collect_pr_context",
  async run(s) {
    const { owner, repo, pullNumber } = s.event;
    s.allFiles = await listAllPRFiles(s.octokit, owner, repo, pullNumber);
    // Inline comments must target lines in the PR diff, whatever subset we review.
    s.commentable = new Map(s.allFiles.map((f) => [f.filename, f.patch ? annotatePatch(f.patch).commentableLines : new Set<number>()]));

    let candidates = s.allFiles;
    if (s.reviewBaseSha) {
      const since = await filesChangedSince(s.octokit, owner, repo, s.reviewBaseSha, s.headSha);
      if (since) {
        const inPR = new Set(s.allFiles.map((f) => f.filename));
        candidates = since.filter((f) => inPR.has(f.filename));
        s.incremental = true;
        s.log.info("incremental review", { files: candidates.length, since: s.reviewBaseSha });
      }
    }
    const ignored = createIgnoreMatcher(s.config);
    s.ignoredFiles = candidates.filter((f) => ignored(f.filename)).map((f) => f.filename);
    s.files = candidates.filter((f) => !ignored(f.filename));

    const [commits, checks] = await Promise.allSettled([
      listCommits(s.octokit, owner, repo, pullNumber),
      listChecks(s.octokit, owner, repo, s.headSha),
    ]);
    if (commits.status === "fulfilled") s.commits = commits.value;
    if (checks.status === "fulfilled") s.checks = checks.value;
    else s.log.warn("CI checks unavailable (needs checks:read)", { error: String(checks.reason?.message ?? checks.reason) });

    const wanted = s.files
      .filter((f) => f.status !== "removed" && classifyFile(f.filename) !== "generated")
      .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, MAX_HEAD_FILES)
      .map((f) => f.filename);
    s.headContents = await getFilesText(s.octokit, owner, repo, wanted, s.headSha);
  },
};

// ─── collect_business_context ────────────────────────────────────────────────
export const collectBusinessContext: Step = {
  name: "collect_business_context",
  optional: true,
  async run(s) {
    const { owner, repo } = s.event;
    s.labels = (s.pr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
    const text = [s.pr.title, s.pr.body ?? "", ...s.commits.map((c) => c.message)].join("\n");
    s.linkedIssues = await fetchIssues(s.octokit, owner, repo, referencedIssueNumbers(text, s.pr.number));
    if (s.pr.user?.login) s.priorPRsByAuthor = await countPriorPRs(s.repositoryId, s.pr.user.login, s.pr.number);
  },
};

// ─── detect_technology / resolve_skills ──────────────────────────────────────
export const detectTechnologyNode: Step = {
  name: "detect_technology",
  optional: true,
  async run(s) {
    const paths = s.treePaths.length > 0 ? s.treePaths : s.allFiles.map((f) => f.filename);
    s.tech = detectTechnology(paths, s.manifests);
  },
};

export const resolveSkillsNode: Step = {
  name: "resolve_skills",
  optional: true,
  async run(s) {
    s.skills = resolveSkills(s.tech, s.config.skills);
  },
};

// ─── build_context_packs ─────────────────────────────────────────────────────
/**
 * Per-stage context: deterministic security pre-scan (to prioritise hot
 * files), related code by vector search per changed file, and exact-match
 * usages of symbols the PR declares or changes.
 */
export const buildContextPacksNode: Step = {
  name: "build_context_packs",
  optional: true,
  async run(s) {
    s.securityScan = [...scanSecrets(s.files), ...scanRiskyPatterns(s.files)];
    const [related, usages] = await Promise.all([loadRelatedCode(s), loadSymbolUsages(s)]);
    s.packs = buildContextPacks({
      files: s.files,
      relatedCode: related,
      symbolUsages: usages,
      securityHotFiles: [...new Set(s.securityScan.map((f) => f.file).filter((f): f is string => Boolean(f)))],
    });
  },
};

async function loadRelatedCode(s: ReviewRunState): Promise<string | undefined> {
  try {
    const rag = new RAGService(EmbeddingService.fromEnv());
    const changed = new Set(s.allFiles.map((f) => f.filename));
    // One query per important file, so the first file no longer dominates the embedding.
    const top = s.files.filter((f) => f.patch && classifyFile(f.filename) === "source").slice(0, 3);
    const results = await Promise.all(top.map((f) => rag.getSimilarChunks(`${f.filename}\n${f.patch!.slice(0, 1_500)}`, s.repositoryId, 6)));
    const seen = new Set<string>();
    const chunks = results
      .flat()
      .filter((c) => !changed.has(c.filePath) && !seen.has(c.id) && seen.add(c.id))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 6);
    return rag.formatContextForPrompt(chunks) || undefined;
  } catch (err) {
    // RAG is best-effort — never block a review on embeddings.
    s.log.warn("related-code lookup skipped", { error: (err as Error).message });
    return undefined;
  }
}

const DECLARATION = /\b(?:function|class|interface|type|enum|const|let|def|func|fn|struct)\s+([A-Za-z_][A-Za-z0-9_]{3,})/g;

/** Names declared on added lines — the symbols most likely to have callers elsewhere. */
export function declaredNames(s: Pick<ReviewRunState, "files">, limit = 12): string[] {
  const names = new Set<string>();
  for (const f of s.files) {
    if (classifyFile(f.filename) !== "source") continue;
    for (const { text } of addedLines(f.patch)) {
      let m;
      DECLARATION.lastIndex = 0;
      while ((m = DECLARATION.exec(text)) !== null) names.add(m[1]);
    }
  }
  return [...names].slice(0, limit);
}

async function loadSymbolUsages(s: ReviewRunState): Promise<string | undefined> {
  const names = declaredNames(s);
  if (names.length === 0) return undefined;
  try {
    const changed = s.allFiles.map((f) => f.filename);
    const rows = await db
      .select({ filePath: codeChunks.filePath, startLine: codeChunks.startLine, endLine: codeChunks.endLine, content: codeChunks.content })
      .from(codeChunks)
      .where(and(eq(codeChunks.repositoryId, s.repositoryId), notInArray(codeChunks.filePath, changed), or(...names.map((n) => ilike(codeChunks.content, `%${escapeLike(n)}%`)))))
      .limit(6);
    if (rows.length === 0) return undefined;
    return (
      "## Existing usages of symbols this PR changes\n" +
      rows.map((r) => `### ${r.filePath} (lines ${r.startLine}–${r.endLine})\n\`\`\`\n${r.content.slice(0, 1_500)}\n\`\`\``).join("\n\n")
    );
  } catch (err) {
    s.log.warn("symbol usage lookup skipped", { error: (err as Error).message });
    return undefined;
  }
}

// ─── build_software_graph ────────────────────────────────────────────────────
/**
 * Import graph around the changed files (resolved against the real tree, with
 * path aliases and workspace packages) plus the functions/classes whose
 * bodies the PR touches (tree-sitter on head contents).
 */
export const buildSoftwareGraph: Step = {
  name: "build_software_graph",
  optional: true,
  async run(s) {
    const changed = s.allFiles.map((f) => f.filename);
    const contents = await loadGraphContents(s.repositoryId, changed);
    for (const [path, text] of s.headContents) contents.set(path, text); // head beats the index

    const resolver = s.treePaths.length > 0
      ? new ImportResolver({ files: s.treePaths, pathAliases: s.tech.pathAliases, workspacePackages: s.tech.workspacePackages })
      : undefined;
    const extractor = new ImportExtractor(resolver);
    const graph = new DependencyGraph();
    for (const [path, text] of contents) graph.addFile(path, extractor.extractImports(text, path));
    s.graph = graph;
    s.graphAvailable = contents.size > s.headContents.size; // had more than just the PR's own files

    for (const file of s.files) {
      const text = s.headContents.get(file.filename);
      if (!text) continue;
      const ext = file.filename.split(".").pop() ?? "";
      if (!astChunker.isSupported(ext)) continue;
      const lines = changedLineSet(file.patch);
      if (lines.size === 0) continue;
      const chunks = await astChunker.chunk(text, ext);
      for (const c of chunks) {
        if (!c.name || c.nodeType === "block") continue;
        let touched = false;
        for (let l = c.startLine; l <= c.endLine && !touched; l++) touched = lines.has(l);
        if (touched) s.changedSymbols.push({ file: file.filename, name: c.name, kind: c.nodeType, startLine: c.startLine, endLine: c.endLine });
      }
    }
  },
};

/**
 * Chunks for the changed files plus files whose code mentions a changed
 * module's name (likely importers). The filter runs in Postgres.
 */
async function loadGraphContents(repositoryId: string, changedFiles: string[]): Promise<Map<string, string>> {
  if (changedFiles.length === 0) return new Map();
  const moduleNames = [
    ...new Set(
      changedFiles
        .map((f) => {
          const parts = f.split("/");
          const base = parts.pop()!.replace(/\.[^.]+$/, "");
          // index.ts is imported by its directory name
          return base === "index" ? parts.pop() ?? "" : base;
        })
        .filter((n) => n.length >= 3)
    ),
  ].slice(0, 50);

  const mentions = moduleNames.map((n) => ilike(codeChunks.content, `%${escapeLike(n)}%`));
  const rows = await db
    .select({ filePath: codeChunks.filePath, content: codeChunks.content, startLine: codeChunks.startLine })
    .from(codeChunks)
    .where(and(eq(codeChunks.repositoryId, repositoryId), or(inArray(codeChunks.filePath, changedFiles), ...mentions)))
    .orderBy(codeChunks.filePath, codeChunks.startLine)
    .limit(MAX_GRAPH_CHUNKS);

  const byFile = new Map<string, string[]>();
  for (const row of rows) byFile.set(row.filePath, [...(byFile.get(row.filePath) ?? []), row.content]);
  return new Map([...byFile].map(([path, parts]) => [path, parts.join("\n")]));
}

// ─── extract_business_intent ─────────────────────────────────────────────────
export const extractBusinessIntent: Step = {
  name: "extract_business_intent",
  optional: true,
  async run(s) {
    s.intent = await s.llm.json(
      buildIntentMessages({
        title: s.pr.title,
        body: s.pr.body,
        commitMessages: s.commits.map((c) => c.message),
        linkedIssues: s.linkedIssues,
        labels: s.labels,
        branch: s.pr.head.ref,
        changedFiles: s.allFiles.map((f) => f.filename),
      }),
      IntentSchema
    );
  },
};

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
