import { db, repositories, codeChunks, codeFiles, and, eq, inArray } from "@codeguard/db";
import type { RepoIndexRequested } from "@codeguard/kafka";
import { aliasesFromTsconfig, chunkFile, embeddingText, importsOf, type Embedder } from "@codeguard/review-engine";
import { installationOctokit } from "../github";

/**
 * Keep a repo's code index in step with its default branch (Day 3.1).
 *
 * The same job serves "first index after install" and "a push just landed":
 *   1. one API call lists every file with its git blob sha (getTree recursive)
 *   2. compare with code_files: same sha → unchanged → skip
 *   3. download only changed blobs → chunk → embed → replace that file's chunks
 *   4. delete rows for files that no longer exist
 * Running it twice is harmless: the second run finds nothing changed.
 */

const CODE = /\.(c|m)?(j|t)sx?$|\.(py|go|rb|java|kt|rs|php|cs|swift|scala|vue|svelte|sql|sh)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.git|__snapshots__)\/|\.min\.|\.generated\.|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MAX_FILES = 1500; // GitHub allows 5,000 requests/hour per installation
const MAX_BYTES = 200_000;
const CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function createIndexJob(embedder: Embedder) {
  return async function onRepoIndexRequested(e: RepoIndexRequested): Promise<void> {
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, e.repositoryId)).limit(1);
    if (!repo?.active) return;
    const started = Date.now();
    const octokit = await installationOctokit(e.installationId);

    const { data: meta } = await octokit.rest.repos.get({ owner: repo.owner, repo: repo.name });
    const sha = e.ref ?? (await octokit.rest.repos.getBranch({ owner: repo.owner, repo: repo.name, branch: meta.default_branch })).data.commit.sha;
    if (repo.indexedSha === sha) return console.info(`[index] ${repo.fullName} already at ${sha.slice(0, 7)}`);

    const { data: tree } = await octokit.rest.git.getTree({ owner: repo.owner, repo: repo.name, tree_sha: sha, recursive: "true" });
    if (tree.truncated) console.warn(`[index] ${repo.fullName}: tree truncated by GitHub; indexing what was returned`);

    const blobs = tree.tree
      .filter((t) => t.type === "blob" && t.path && t.sha && CODE.test(t.path) && !SKIP.test(t.path) && (t.size ?? 0) <= MAX_BYTES)
      .slice(0, MAX_FILES) as Array<{ path: string; sha: string }>;
    const allPaths = new Set(blobs.map((b) => b.path));

    const known = new Map(
      (await db.select({ path: codeFiles.path, blobSha: codeFiles.blobSha }).from(codeFiles).where(eq(codeFiles.repositoryId, repo.id))).map((r) => [r.path, r.blobSha]),
    );
    const changed = blobs.filter((b) => known.get(b.path) !== b.sha);
    const removed = [...known.keys()].filter((p) => !allPaths.has(p));

    // Path aliases (e.g. "@/…") come from the repo's own tsconfig, if any.
    const tsconfigBlob = tree.tree.find((t) => t.path === "tsconfig.json" && t.sha);
    const tsconfig = tsconfigBlob ? await readBlob(octokit, repo.owner, repo.name, tsconfigBlob.sha!) : null;
    const aliases = aliasesFromTsconfig(tsconfig);

    let chunkCount = 0;
    // Process in slices so memory stays flat and progress is saved as we go.
    for (let i = 0; i < changed.length; i += 40) {
      const slice = changed.slice(i, i + 40);
      const contents = await mapLimit(slice, CONCURRENCY, (b) => readBlob(octokit, repo.owner, repo.name, b.sha));
      const files = slice
        .map((b, k) => ({ ...b, content: contents[k] }))
        .filter((f): f is { path: string; sha: string; content: string } => f.content !== null);

      const chunks = files.flatMap((f) => chunkFile(f.path, f.content).map((c) => ({ file: f, chunk: c })));
      const vectors = await embedder.embed(chunks.map(({ file, chunk }) => embeddingText(file.path, chunk)));
      chunkCount += chunks.length;

      await db.transaction(async (tx) => {
        const paths = files.map((f) => f.path);
        if (paths.length) await tx.delete(codeChunks).where(and(eq(codeChunks.repositoryId, repo.id), inArray(codeChunks.path, paths)));
        if (chunks.length) {
          await tx.insert(codeChunks).values(
            chunks.map(({ file, chunk }, k) => ({
              repositoryId: repo.id,
              path: file.path,
              symbol: chunk.symbol,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              embedding: vectors[k],
              commitSha: sha,
            })),
          );
        }
        for (const f of files) {
          const imports = importsOf(f.path, f.content, allPaths, aliases);
          await tx
            .insert(codeFiles)
            .values({ repositoryId: repo.id, path: f.path, blobSha: f.sha, imports })
            .onConflictDoUpdate({ target: [codeFiles.repositoryId, codeFiles.path], set: { blobSha: f.sha, imports, updatedAt: new Date() } });
        }
      });
    }

    if (removed.length) {
      await db.delete(codeChunks).where(and(eq(codeChunks.repositoryId, repo.id), inArray(codeChunks.path, removed)));
      await db.delete(codeFiles).where(and(eq(codeFiles.repositoryId, repo.id), inArray(codeFiles.path, removed)));
    }

    await db
      .update(repositories)
      .set({ indexedSha: sha, indexedAt: new Date(), defaultBranch: meta.default_branch, updatedAt: new Date() })
      .where(eq(repositories.id, repo.id));
    console.info(
      `[index] ${repo.fullName} @ ${sha.slice(0, 7)}: ${changed.length} changed, ${removed.length} removed, ${chunkCount} chunks, ${Date.now() - started} ms`,
    );
  };
}

async function readBlob(octokit: Awaited<ReturnType<typeof installationOctokit>>, owner: string, repo: string, sha: string): Promise<string | null> {
  const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: sha });
  const buf = Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8");
  if (buf.includes(0)) return null; // binary
  return buf.toString("utf8");
}
