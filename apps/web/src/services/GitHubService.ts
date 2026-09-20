import { auth, clerkClient } from "@clerk/nextjs/server";
import { Octokit } from "octokit";
import type { ReviewIssue } from "@codeguard/types";

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
  diffContext: string;
}

export interface GitHubPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface PostCommentResult {
  htmlUrl: string;
  reviewId: number;
}

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
      throw new Error("Unauthorized");
    }

    const client = await clerkClient();
    const response = await client.users.getUserOauthAccessToken(
      userId,
      "oauth_github"
    );

    const token = response.data?.[0]?.token;
    if (!token) {
      throw new Error(
        "GitHub OAuth token not found. Please sign in with GitHub."
      );
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
    const [{ data: pr }, { data: files }] = await Promise.all([
      this.octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
      this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 50,
      }),
    ]);

    // Build the diff context string consumed by AIReviewService
    const diffContext = files
      .map(
        (f) =>
          `File: ${f.filename} (${f.status})\nPatch:\n${f.patch ?? "No patch available"}`
      )
      .join("\n\n---\n\n");

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
      diffContext,
    };
  }

  /**
   * Post a formatted CodeGuard AI review comment on a GitHub PR.
   * Tries pulls.createReview first, falls back to issues.createComment.
   */
  async postReviewComment(
    owner: string,
    repo: string,
    pullNumber: number,
    score: number,
    summary: string,
    issues: ReviewIssue[]
  ): Promise<PostCommentResult> {
    const body = this.formatReviewBody(score, summary, issues);

    try {
      const { data } = await this.octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: "COMMENT",
        body,
      });
      return { htmlUrl: data.html_url, reviewId: data.id };
    } catch (primaryErr: any) {
      console.warn(
        "pulls.createReview failed, trying issues.createComment fallback:",
        primaryErr?.message
      );

      try {
        const { data } = await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body,
        });
        return { htmlUrl: data.html_url, reviewId: data.id };
      } catch (fallbackErr: any) {
        if (
          fallbackErr?.status === 403 ||
          fallbackErr?.message?.includes("Must have admin rights") ||
          fallbackErr?.message?.includes("Resource not accessible")
        ) {
          throw new Error(
            "GitHub Permission Error: Write/admin access is required to post PR comments, or your OAuth token lacks the 'repo' scope."
          );
        }
        throw fallbackErr;
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private formatReviewBody(
    score: number,
    summary: string,
    issues: ReviewIssue[]
  ): string {
    const formattedIssues = issues
      .map(
        (issue, idx) =>
          `### ${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.category}\n` +
          `**Message**: ${issue.message}\n` +
          (issue.line != null ? `**Line**: ${issue.line}\n` : "") +
          (issue.suggestion
            ? `\n\`\`\`suggestion\n${issue.suggestion}\n\`\`\`\n`
            : "")
      )
      .join("\n\n");

    return `## 🛡️ CodeGuard AI Review Summary

**Quality Score**: \`${score.toFixed(1)} / 10\`

### Executive Summary
${summary}

---

### Identified Issues (${issues.length})
${formattedIssues || "🎉 No major security or code quality issues detected!"}

---
*Powered by CodeGuard AI Reviewer*`;
  }
}
