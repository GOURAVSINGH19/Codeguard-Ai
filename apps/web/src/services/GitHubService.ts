import { auth, clerkClient } from "@clerk/nextjs/server";
import { Octokit } from "octokit";
import { HttpError } from "@/lib/api";
import { postReview } from "@codeguard/review-engine";
import type { PostReviewInput, PostReviewResult, PRFileInput } from "@codeguard/review-engine";

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
  language: string | null;
  description: string | null;
}

export interface GitHubPR {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  authorLogin: string;
  authorAvatar: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPRDetail extends GitHubPR {
  additions: number;
  deletions: number;
  changedFiles: number;
  repoId: number;
  repoFullName: string;
  repoDefaultBranch: string;
  repoIsPrivate: boolean;
  repoLanguage: string | null;
  repoCloneUrl: string | null;
  repoHtmlUrl: string | null;
  files: GitHubPRFile[];
  /** Files with their patches, for the review engine (not sent to the browser). */
  patches: PRFileInput[];
}

export interface GitHubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export type PostCommentResult = PostReviewResult;

/**
 * GitHubService
 *
 * Single owner of all Octokit / GitHub API logic:
 * - Listing repos and PRs
 * - Fetching PR diffs
 * - Posting review comments
 *
 * No DB access. No AI logic. No HTTP framework imports.
 */
export class GitHubService {
  private readonly octokit: Octokit;

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  /**
   * Factory — resolves Clerk OAuth token for the current request.
   * Must be called from a Next.js server context (API Route / Server Action).
   */
  static async fromCurrentUser(): Promise<GitHubService> {
    const { userId } = await auth();
    if (!userId) {
      throw new HttpError(401, "Unauthorized");
    }

    const client = await clerkClient();
    const response = await client.users.getUserOauthAccessToken(
      userId,
      "oauth_github"
    );

    const token = response.data?.[0]?.token;
    if (!token) {
      throw new HttpError(400, "No GitHub connection found. Please sign in with GitHub.", "github_not_connected");
    }

    return new GitHubService(new Octokit({ auth: token }));
  }

  /**
   * List repos for the authenticated user, sorted by last updated.
   */
  async listRepos(): Promise<GitHubRepo[]> {
    const { data } = await this.octokit.rest.repos.listForAuthenticatedUser({
      sort: "updated",
      per_page: 50,
    });

    return data.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      private: repo.private,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      language: repo.language ?? null,
      description: repo.description ?? null,
    }));
  }

  /**
   * List open pull requests for a given repo.
   */
  async listOpenPRs(owner: string, repo: string): Promise<GitHubPR[]> {
    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: 30,
    });

    return data.map((pr) => ({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? null,
      state: pr.state,
      authorLogin: pr.user?.login ?? "unknown",
      authorAvatar: pr.user?.avatar_url ?? null,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      htmlUrl: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    }));
  }

  /**
   * Fetch full PR detail including diff context string ready for the AI.
   */
  async getPRDetail(
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<GitHubPRDetail> {
    const [{ data: pr }, files] = await Promise.all([
      this.octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
      // All pages (GitHub caps a PR at 3,000 files) — not just the first 50.
      this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      }),
    ]);

    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? null,
      state: pr.state,
      authorLogin: pr.user?.login ?? "unknown",
      authorAvatar: pr.user?.avatar_url ?? null,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      htmlUrl: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      // Repo metadata needed for DB upsert
      repoId: pr.base.repo.id,
      repoFullName: pr.base.repo.full_name,
      repoDefaultBranch: pr.base.repo.default_branch ?? "main",
      repoIsPrivate: pr.base.repo.private ?? false,
      repoLanguage: pr.base.repo.language ?? null,
      repoCloneUrl: pr.base.repo.clone_url ?? null,
      repoHtmlUrl: pr.base.repo.html_url ?? null,
      files: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      patches: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      })),
    };
  }

  /**
   * Post a stored review to the PR: inline comments on changed lines plus a
   * summary. Falls back to summary-only and then to an issue comment.
   */
  async postReview(input: PostReviewInput): Promise<PostCommentResult> {
    try {
      return await postReview(this.octokit, input);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        throw new HttpError(403, "GitHub denied the comment. You need write access to this repository.", "github_forbidden");
      }
      throw err;
    }
  }
}
