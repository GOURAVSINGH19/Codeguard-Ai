import { describe, it, expect, vi } from "vitest";

vi.mock("@codeguard/db", () => ({ db: {}, webhookEvents: {}, repositories: {}, eq: () => ({}) }));

const { decideRoute } = await import("../webhookProcessor.js");
const { PermanentError } = await import("../../queue/consumer.js");

type Repo = { id: string; autoReviewEnabled: boolean; defaultBranch: string; status: string };
const repo = (over: Partial<Repo> = {}): Repo => ({
  id: "11111111-1111-4111-8111-111111111111",
  autoReviewEnabled: true,
  defaultBranch: "main",
  status: "active",
  ...over,
});
const lookup = (r: Repo | null) => vi.fn(async () => r);

const envelope = (githubEvent: string, payload: unknown) => ({
  githubEvent,
  deliveryId: "delivery-1",
  payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  receivedAt: new Date().toISOString(),
});

const prPayload = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  before: "aaaaaaa1111111",
  installation: { id: 42 },
  repository: { name: "api", owner: { login: "acme" } },
  pull_request: { number: 7, draft: false, head: { sha: "bbbbbbb2222222" } },
  ...extra,
});

describe("decideRoute — pull_request", () => {
  it.each(["opened", "reopened", "ready_for_review"])("requests a full review on %s", async (action) => {
    const out = await decideRoute(envelope("pull_request", prPayload(action)), lookup(repo()));
    expect(out.kind).toBe("review");
    if (out.kind === "review") {
      expect(out.event).toMatchObject({ owner: "acme", repo: "api", pullNumber: 7, installationId: 42, headSha: "bbbbbbb2222222", previousHeadSha: null });
    }
  });

  it("passes the previous head on synchronize for an incremental review", async () => {
    const out = await decideRoute(envelope("pull_request", prPayload("synchronize")), lookup(repo()));
    expect(out.kind === "review" && out.event.previousHeadSha).toBe("aaaaaaa1111111");
  });

  it("ignores closed/labeled PRs, drafts, disconnected repos and repos with auto-review off", async () => {
    expect((await decideRoute(envelope("pull_request", prPayload("closed")), lookup(repo()))).kind).toBe("ignored");
    const draft = prPayload("opened", { pull_request: { number: 7, draft: true, head: { sha: "bbbbbbb2222222" } } });
    expect((await decideRoute(envelope("pull_request", draft), lookup(repo()))).kind).toBe("ignored");
    expect((await decideRoute(envelope("pull_request", prPayload("opened")), lookup(null))).kind).toBe("ignored");
    expect((await decideRoute(envelope("pull_request", prPayload("opened")), lookup(repo({ autoReviewEnabled: false })))).kind).toBe("ignored");
    expect((await decideRoute(envelope("pull_request", prPayload("opened")), lookup(repo({ status: "inactive" })))).kind).toBe("ignored");
  });

  it("treats unparseable payloads as permanent failures (→ DLQ, no retries)", async () => {
    await expect(decideRoute(envelope("pull_request", "{not json"), lookup(repo()))).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("decideRoute — push", () => {
  const push = (ref: string, after = "ccccccc3333333") => ({
    ref,
    before: "0000000",
    after,
    repository: { id: 1, name: "api", full_name: "acme/api", owner: { login: "acme" }, clone_url: "", default_branch: "main" },
    pusher: { name: "dev" },
    commits: [{ id: "1", message: "m", timestamp: "t", author: { name: "a", email: "e" }, added: ["a.ts"], modified: ["b.ts"], removed: ["c.ts"] }],
  });

  it("indexes pushes to the default branch, including the ref", async () => {
    const out = await decideRoute(envelope("push", push("refs/heads/main")), lookup(repo()));
    expect(out.kind).toBe("index");
    if (out.kind === "index") {
      expect(out.event.ref).toBe("refs/heads/main");
      expect(out.event.changedFiles.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    }
  });

  it("ignores feature-branch pushes and branch deletions", async () => {
    expect((await decideRoute(envelope("push", push("refs/heads/feature")), lookup(repo()))).kind).toBe("ignored");
    expect((await decideRoute(envelope("push", push("refs/heads/main", "0000000000000000000000000000000000000000")), lookup(repo()))).kind).toBe("ignored");
  });
});
