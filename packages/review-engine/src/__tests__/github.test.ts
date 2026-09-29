import { describe, it, expect, vi } from "vitest";
import { buildInlineComments, formatReviewBody, neutralizeMentions, postReview } from "../github";
import type { GitHubClientLike } from "../github";
import type { ReviewIssue } from "@codeguard/types";

const issue = (over: Partial<ReviewIssue>): ReviewIssue => ({
  severity: "high",
  category: "bug",
  file: "src/a.ts",
  line: 12,
  message: "Null dereference",
  suggestion: "if (!x) return;",
  ...over,
});

const commentable = new Map([["src/a.ts", new Set([10, 11, 12])]]);

describe("buildInlineComments", () => {
  it("inlines only issues on lines present in the diff", () => {
    const { comments, rest } = buildInlineComments(
      [issue({}), issue({ line: 99 }), issue({ file: null, line: null }), issue({ file: "other.ts" })],
      commentable
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: "src/a.ts", line: 12, side: "RIGHT" });
    expect(rest).toHaveLength(3);
  });
});

describe("formatting", () => {
  it("neutralizes @mentions coming from model output", () => {
    expect(neutralizeMentions("ping @octocat and @org/team")).not.toMatch(/@[a-z]/);
  });

  it("fences suggestions safely even when they contain backticks", () => {
    const body = formatReviewBody({ score: 5, summary: "s", issues: [issue({ suggestion: "```js\nx\n```" })], inlineCount: 0 });
    expect(body).toContain("````");
    expect(body).not.toContain("```suggestion");
  });
});

function client(overrides: Partial<{ review: ReturnType<typeof vi.fn>; comment: ReturnType<typeof vi.fn> }> = {}) {
  const review = overrides.review ?? vi.fn().mockResolvedValue({ data: { id: 1, html_url: "https://gh/r/1" } });
  const comment = overrides.comment ?? vi.fn().mockResolvedValue({ data: { id: 2, html_url: "https://gh/c/2" } });
  const c: GitHubClientLike = { rest: { pulls: { createReview: review }, issues: { createComment: comment } } };
  return { c, review, comment };
}

const input = { owner: "o", repo: "r", pullNumber: 1, commitId: "abc1234", score: 7, summary: "ok", issues: [issue({}), issue({ line: null })], commentable };

describe("postReview", () => {
  it("posts inline comments on the reviewed commit", async () => {
    const { c, review } = client();
    const res = await postReview(c, input);
    expect(res).toMatchObject({ mode: "review", inlineCount: 1 });
    expect(review.mock.calls[0][0]).toMatchObject({ commit_id: "abc1234", event: "COMMENT" });
    expect(review.mock.calls[0][0].comments).toHaveLength(1);
  });

  it("falls back to summary-only when GitHub rejects a line (422)", async () => {
    const review = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Unprocessable"), { status: 422 })).mockResolvedValue({ data: { id: 3, html_url: "u" } });
    const { c } = client({ review });
    const res = await postReview(c, input);
    expect(res.mode).toBe("review-summary-only");
    expect(review.mock.calls[1][0].comments).toBeUndefined();
  });

  it("falls back to an issue comment when reviews are not allowed", async () => {
    const review = vi.fn().mockRejectedValue(new Error("Can not approve your own pull request"));
    const { c, comment } = client({ review });
    const res = await postReview(c, input);
    expect(res.mode).toBe("issue-comment");
    expect(comment).toHaveBeenCalledOnce();
  });
});
