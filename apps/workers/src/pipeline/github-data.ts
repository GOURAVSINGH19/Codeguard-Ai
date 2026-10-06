import type { Octokit } from "octokit";
import { CONFIG_FILE_PATH, parseRepoConfig } from "@codeguard/review-engine";
import type { CheckResult, PRFileInput, RepoConfig } from "@codeguard/review-engine";
import type { Logger } from "../lib/logger.js";

/** GitHub caps `pulls.listFiles` at 3,000 files. */
const MAX_PR_FILES = 3_000;
/** Files above this are not fetched for symbol extraction. */
const MAX_CONTENT_BYTES = 200_000;

export async function listAllPRFiles(octokit: Octokit, owner: string, repo: string, pullNumber: number): Promise<PRFileInput[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 });
  return files.slice(0, MAX_PR_FILES).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? null,
  }));
}

/** Files changed between two commits, or null when history was rewritten (force-push / rebase). */
export async function filesChangedSince(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<PRFileInput[] | null> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}` });
    if (data.status !== "ahead" || !data.files) return null;
    return data.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null }));
  } catch {
    return null;
  }
}

/**
 * `.codeguard.yml` is read from the BASE commit, so a PR can't weaken its own
 * review (e.g. by adding `ignore: ["**"]`).
 */
export async function loadRepoConfig(octokit: Octokit, owner: string, repo: string, baseSha: string, log: Logger): Promise<RepoConfig> {
  try {
    const content = await getFileText(octokit, owner, repo, CONFIG_FILE_PATH, baseSha);
    const { config, warning } = parseRepoConfig(content);
    if (warning) log.warn(warning);
    return config;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) log.warn("could not read repo config", { error: (err as Error).message });
    return parseRepoConfig(null).config;
  }
}

export async function getFileText(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
  if ((data.size ?? 0) > MAX_CONTENT_BYTES) return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

/** Fetch several files at one ref, at most `concurrency` at a time; missing files are skipped. */
export async function getFilesText(octokit: Octokit, owner: string, repo: string, paths: string[], ref: string, concurrency = 6): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      try {
        const text = await getFileText(octokit, owner, repo, path, ref);
        if (text !== null) out.set(path, text);
      } catch {
        // deleted, binary, too large or no access — skip
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

export async function getTreePaths(octokit: Octokit, owner: string, repo: string, sha: string): Promise<{ paths: string[]; truncated: boolean }> {
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: "1" });
  return {
    paths: (data.tree ?? []).filter((t) => t.type === "blob" && t.path).map((t) => t.path!),
    truncated: Boolean(data.truncated),
  };
}

export async function listCommits(octokit: Octokit, owner: string, repo: string, pullNumber: number) {
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 });
  return commits.slice(0, 250).map((c) => ({ sha: c.sha, message: c.commit.message, author: c.author?.login ?? c.commit.author?.name ?? null }));
}

/** CI results on the head commit, excluding our own check. */
export async function listChecks(octokit: Octokit, owner: string, repo: string, sha: string): Promise<CheckResult[]> {
  const { data } = await octokit.rest.checks.listForRef({ owner, repo, ref: sha, per_page: 100, filter: "latest" });
  return data.check_runs
    .filter((c) => c.name !== "CodeGuard AI")
    .map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? null, url: c.html_url ?? null }));
}

/** Issue numbers referenced by the PR text ("fixes #12", "see #34"). */
export function referencedIssueNumbers(text: string, self: number, limit = 3): number[] {
  const nums: number[] = [];
  const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
  const plain = /(?:^|[\s(])#(\d+)\b/g;
  for (const re of [closing, plain]) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (n !== self && !nums.includes(n)) nums.push(n);
    }
  }
  return nums.slice(0, limit);
}

export async function fetchIssues(octokit: Octokit, owner: string, repo: string, numbers: number[]) {
  const out: Array<{ number: number; title: string; body: string | null }> = [];
  for (const n of numbers) {
    try {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: n });
      out.push({ number: n, title: data.title, body: data.body ?? null });
    } catch {
      // deleted, transferred or a PR number in another repo — ignore
    }
  }
  return out;
}
