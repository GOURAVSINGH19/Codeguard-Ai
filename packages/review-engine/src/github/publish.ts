import type { Octokit } from "octokit";
import type { Severity } from "../schema";

export const CHECK_NAME = "CodeGuard AI";

export interface PublishFinding {
  file: string | null;
  line: number | null;
  severity: Severity;
  category: string;
  message: string;
  suggestion: string | null;
  source?: string;
}

const ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };

export function commentMarkdown(f: PublishFinding): string {
  const suggestion = f.suggestion
    ? `\n\n**Suggestion**\n${f.suggestion.includes("\n") || /[;{}()=]/.test(f.suggestion) ? "```\n" + f.suggestion + "\n```" : f.suggestion}`
    : "";
  return `${ICON[f.severity]} **${f.severity.toUpperCase()}** · ${f.category}${f.source === "eslint" ? " · ESLint" : ""}\n\n${f.message}${suggestion}`;
}

export function summaryMarkdown(input: {
  score: number;
  summary: string;
  findings: PublishFinding[];
  offDiff: PublishFinding[];
  detailsUrl?: string | null;
}): string {
  const counts = (["critical", "high", "medium", "low"] as const)
    .map((s) => `${ICON[s]} ${input.findings.filter((f) => f.severity === s).length} ${s}`)
    .join(" · ");
  const offDiff = input.offDiff.length
    ? `\n\n<details><summary>${input.offDiff.length} finding(s) outside the changed lines</summary>\n\n${input.offDiff
        .map((f) => `- ${ICON[f.severity]} \`${f.file ?? "PR"}${f.line ? `:${f.line}` : ""}\` ${f.message}`)
        .join("\n")}\n</details>`
    : "";
  const link = input.detailsUrl ? `\n\n[Open the full review](${input.detailsUrl})` : "";
  return `### 🛡️ CodeGuard AI review: ${input.score}/100\n\n${input.summary}\n\n${counts}${offDiff}${link}`;
}

/**
 * Post one PR review: a summary body plus inline comments.
 * - Inline comments only on lines GitHub accepts (inside the diff); everything else goes in the body.
 * - Always event "COMMENT": blocking is the Check Run's job (team policy), not the review's.
 * - If GitHub still rejects an inline comment (422), retry with everything in the body.
 */
export async function publishReview(
  octokit: Octokit,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    score: number;
    summary: string;
    findings: PublishFinding[];
    commentable: Map<string, Set<number>>;
    detailsUrl?: string | null;
  },
): Promise<{ htmlUrl: string }> {
  const inline = input.findings.filter((f) => f.file && f.line && input.commentable.get(f.file)?.has(f.line));
  const offDiff = input.findings.filter((f) => !inline.includes(f));

  const send = (comments: PublishFinding[], rest: PublishFinding[]) =>
    octokit.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      commit_id: input.headSha,
      event: "COMMENT",
      body: summaryMarkdown({ ...input, offDiff: rest }),
      comments: comments.map((f) => ({ path: f.file!, line: f.line!, side: "RIGHT" as const, body: commentMarkdown(f) })),
    });

  try {
    const { data } = await send(inline, offDiff);
    return { htmlUrl: data.html_url };
  } catch (err) {
    if ((err as { status?: number }).status !== 422 || inline.length === 0) throw err;
    const { data } = await send([], input.findings);
    return { htmlUrl: data.html_url };
  }
}

/** Start the "CodeGuard AI" check (a spinner on the PR). Returns null if the App lacks Checks permission. */
export async function startCheckRun(
  octokit: Octokit,
  input: { owner: string; repo: string; headSha: string; detailsUrl?: string | null },
): Promise<number | null> {
  try {
    const { data } = await octokit.rest.checks.create({
      owner: input.owner,
      repo: input.repo,
      name: CHECK_NAME,
      head_sha: input.headSha,
      status: "in_progress",
      ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    });
    return data.id;
  } catch (err) {
    console.warn("[checks] could not create check run:", (err as Error).message);
    return null;
  }
}

export async function completeCheckRun(
  octokit: Octokit,
  input: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
  },
): Promise<void> {
  await octokit.rest.checks.update({
    owner: input.owner,
    repo: input.repo,
    check_run_id: input.checkRunId,
    status: "completed",
    conclusion: input.conclusion,
    output: { title: input.title.slice(0, 255), summary: input.summary.slice(0, 65_000) },
  });
}
