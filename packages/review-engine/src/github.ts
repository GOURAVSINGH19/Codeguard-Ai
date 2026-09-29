import type { ReviewIssue } from "@codeguard/types";
import type { CheckConclusion } from "./repo-config";

/**
 * GitHub output: summary body, inline review comments and a Check Run.
 * Accepts any Octokit-like client so this package has no octokit dependency.
 */

export interface GitHubClientLike {
  rest: {
    pulls: {
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        event: "COMMENT";
        body: string;
        commit_id?: string;
        comments?: Array<{ path: string; line: number; side: "RIGHT"; body: string }>;
      }): Promise<{ data: { id: number; html_url: string } }>;
    };
    issues: {
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<{ data: { id: number; html_url: string } }>;
    };
  };
}

export interface ChecksClientLike {
  rest: {
    checks: {
      create(params: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: "completed";
        conclusion: CheckConclusion;
        output: { title: string; summary: string };
      }): Promise<unknown>;
    };
  };
}

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

const SEVERITY_ICON: Record<ReviewIssue["severity"], string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

/** Stop model output from @-mentioning people or teams. */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, "@​");
}

function fence(code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${code}\n${ticks}`;
}

function issueBody(issue: ReviewIssue): string {
  const head = `${SEVERITY_ICON[issue.severity]} **${issue.severity.toUpperCase()}** · ${issue.category}`;
  const suggestion = issue.suggestion ? `\n\n**Suggested fix**\n${fence(issue.suggestion)}` : "";
  return neutralizeMentions(`${head}\n\n${issue.message}${suggestion}`);
}

/**
 * Split issues into inline comments (file + line present in the diff) and the
 * rest, which go into the summary body.
 */
export function buildInlineComments(
  issues: ReviewIssue[],
  commentable: Map<string, Set<number>>
): { comments: InlineComment[]; rest: ReviewIssue[] } {
  const comments: InlineComment[] = [];
  const rest: ReviewIssue[] = [];
  for (const issue of issues) {
    if (issue.file && issue.line && commentable.get(issue.file)?.has(issue.line)) {
      comments.push({ path: issue.file, line: issue.line, side: "RIGHT", body: issueBody(issue) });
    } else {
      rest.push(issue);
    }
  }
  return { comments, rest };
}

export interface SummaryOptions {
  score: number;
  summary: string;
  /** Issues NOT posted inline (listed in full in the body). */
  issues: ReviewIssue[];
  inlineCount: number;
  notes?: string[];
  footer?: string;
}

export function formatReviewBody(opts: SummaryOptions): string {
  const listed = opts.issues
    .map((issue, idx) => {
      const where = issue.file ? ` — \`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : issue.line ? ` — line ${issue.line}` : "";
      const suggestion = issue.suggestion ? `\n\n**Suggested fix**\n${fence(issue.suggestion)}` : "";
      return `### ${idx + 1}. ${SEVERITY_ICON[issue.severity]} [${issue.severity.toUpperCase()}] ${issue.category}${where}\n${issue.message}${suggestion}`;
    })
    .join("\n\n");

  const total = opts.issues.length + opts.inlineCount;
  const inlineLine = opts.inlineCount > 0 ? `\n${opts.inlineCount} issue(s) are posted as inline comments on the changed lines.\n` : "";
  const notes = opts.notes && opts.notes.length > 0 ? `\n<details><summary>Review scope</summary>\n\n${opts.notes.map((n) => `- ${n}`).join("\n")}\n</details>\n` : "";

  return neutralizeMentions(`## 🛡️ CodeGuard AI Review

**Quality score:** \`${opts.score.toFixed(1)} / 10\` · **Issues:** ${total}

### Summary
${opts.summary}
${inlineLine}
${listed ? `---\n\n### Other findings\n${listed}\n` : total === 0 ? "🎉 No issues found.\n" : ""}${notes}
---
*${opts.footer ?? "Powered by CodeGuard AI"}*`);
}

export interface PostReviewInput {
  owner: string;
  repo: string;
  pullNumber: number;
  /** Head SHA the review was run against (keeps inline comments on the right commit). */
  commitId?: string;
  score: number;
  summary: string;
  issues: ReviewIssue[];
  commentable: Map<string, Set<number>>;
  notes?: string[];
  footer?: string;
}

export interface PostReviewResult {
  id: number;
  htmlUrl: string;
  inlineCount: number;
  mode: "review" | "review-summary-only" | "issue-comment";
}

/**
 * Post a PR review with inline comments. Falls back to a summary-only review
 * (e.g. GitHub rejects a line with 422) and then to a plain issue comment
 * (e.g. reviewing your own PR with some token types).
 */
export async function postReview(client: GitHubClientLike, input: PostReviewInput): Promise<PostReviewResult> {
  const { comments, rest } = buildInlineComments(input.issues, input.commentable);
  const withInline = formatReviewBody({ ...input, issues: rest, inlineCount: comments.length });

  if (comments.length > 0) {
    try {
      const { data } = await client.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        event: "COMMENT",
        commit_id: input.commitId,
        body: withInline,
        comments,
      });
      return { id: data.id, htmlUrl: data.html_url, inlineCount: comments.length, mode: "review" };
    } catch (err) {
      console.warn("[review-engine] inline review rejected, retrying as summary only:", (err as Error).message);
    }
  }

  const summaryOnly = formatReviewBody({ ...input, issues: input.issues, inlineCount: 0 });
  try {
    const { data } = await client.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      event: "COMMENT",
      commit_id: input.commitId,
      body: summaryOnly,
    });
    return { id: data.id, htmlUrl: data.html_url, inlineCount: 0, mode: "review-summary-only" };
  } catch (err) {
    console.warn("[review-engine] createReview failed, falling back to issue comment:", (err as Error).message);
  }

  const { data } = await client.rest.issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.pullNumber,
    body: summaryOnly,
  });
  return { id: data.id, htmlUrl: data.html_url, inlineCount: 0, mode: "issue-comment" };
}

export interface CheckRunInput {
  owner: string;
  repo: string;
  headSha: string;
  conclusion: CheckConclusion;
  score: number;
  issues: ReviewIssue[];
  failOn: string;
}

/** Create a completed "CodeGuard AI" Check Run so teams can gate merges on it. */
export async function createCheckRun(client: ChecksClientLike, input: CheckRunInput): Promise<void> {
  const counts = (["critical", "high", "medium", "low"] as const)
    .map((s) => `${s}: ${input.issues.filter((i) => i.severity === s).length}`)
    .join(" · ");
  const title =
    input.conclusion === "failure"
      ? `Blocking issues found (fail_on: ${input.failOn})`
      : input.conclusion === "success"
        ? "No issues found"
        : `${input.issues.length} non-blocking issue(s)`;

  await client.rest.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: "CodeGuard AI",
    head_sha: input.headSha,
    status: "completed",
    conclusion: input.conclusion,
    output: {
      title,
      summary: `Score **${input.score.toFixed(1)}/10** — ${counts}. See the review on the pull request for details.`,
    },
  });
}
