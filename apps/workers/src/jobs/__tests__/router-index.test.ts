import { describe, expect, it, vi } from "vitest";

vi.mock("@codeguard/db", () => ({}));
vi.mock("@codeguard/kafka", () => ({}));

import { decideIndexFromPayload } from "../router";

const installation = { id: 5 };

describe("decideIndexFromPayload", () => {
  it("indexes every granted repo when the App is installed", () => {
    expect(decideIndexFromPayload("installation", { action: "created", installation, repositories: [{ id: 1 }, { id: 2 }] })).toEqual({
      installationId: 5, githubRepoIds: [1, 2], ref: null, reason: "installed",
    });
  });

  it("indexes repos added to an existing installation", () => {
    expect(decideIndexFromPayload("installation_repositories", { action: "added", installation, repositories_added: [{ id: 9 }] })?.githubRepoIds).toEqual([9]);
  });

  it("indexes a push to the default branch at the pushed commit", () => {
    const push = { ref: "refs/heads/main", after: "b".repeat(40), installation, repository: { id: 3, default_branch: "main" } };
    expect(decideIndexFromPayload("push", push)).toEqual({ installationId: 5, githubRepoIds: [3], ref: "b".repeat(40), reason: "push" });
  });

  it("ignores pushes to other branches and branch deletions", () => {
    const repo = { id: 3, default_branch: "main" };
    expect(decideIndexFromPayload("push", { ref: "refs/heads/feature", after: "b".repeat(40), installation, repository: repo })).toBeNull();
    expect(decideIndexFromPayload("push", { ref: "refs/heads/main", after: "0".repeat(40), deleted: true, installation, repository: repo })).toBeNull();
  });

  it("ignores uninstalls and PR events", () => {
    expect(decideIndexFromPayload("installation", { action: "deleted", installation })).toBeNull();
    expect(decideIndexFromPayload("pull_request", { action: "opened", installation })).toBeNull();
  });
});
