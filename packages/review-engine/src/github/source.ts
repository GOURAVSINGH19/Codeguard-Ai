import type { Octokit } from "octokit";
import type { DiffFile } from "../diff";

/** Is this a GitHub "not found" error (e.g. a commit that a force-push removed)? */
export const isNotFound = (err: unknown) => (err as { status?: number })?.status === 404;

/**
 * Files changed between two commits, with patches.
 * Three-dot compare (base...head) = exactly what the PR's "Files changed" tab shows.
 * GitHub returns at most 300 files here, which is plenty for a review.
 */
export async function fetchDiffFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<DiffFile[]> {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${base}...${head}`, per_page: 300 });
  return (data.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
}

/** A file's text at a commit, or null (deleted, a directory, binary, or too big). */
export async function fetchFileAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  maxBytes = 200_000,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data) || data.size > maxBytes) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
