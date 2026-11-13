import { describe, expect, it, vi } from "vitest";

vi.mock("@codeguard/db", () => ({}));
vi.mock("@codeguard/kafka", () => ({}));

import { decideFromPayload } from "../router";

const base = {
  action: "opened",
  number: 7,
  installation: { id: 1 },
  repository: { id: 99, full_name: "octocat/hello" },
  pull_request: { draft: false, state: "open", head: { sha: "a".repeat(40) } },
};

describe("decideFromPayload", () => {
  it("reviews an opened PR", () => {
    expect(decideFromPayload("pull_request", base)).toEqual({
      review: true, installationId: 1, githubRepoId: 99, prNumber: 7, headSha: "a".repeat(40),
    });
  });

  it.each(["synchronize", "reopened", "ready_for_review"])("reviews on %s", (action) => {
    expect(decideFromPayload("pull_request", { ...base, action }).review).toBe(true);
  });

  it.each(["closed", "labeled", "edited", "assigned"])("ignores %s", (action) => {
    expect(decideFromPayload("pull_request", { ...base, action }).review).toBe(false);
  });

  it("ignores drafts", () => {
    expect(decideFromPayload("pull_request", { ...base, pull_request: { ...base.pull_request, draft: true } })).toEqual({ review: false, reason: "draft PR" });
  });

  it("ignores other event types", () => {
    expect(decideFromPayload("push", base).review).toBe(false);
  });

  it("ignores incomplete payloads instead of crashing", () => {
    expect(decideFromPayload("pull_request", { action: "opened" }).review).toBe(false);
  });
});
