import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks: a tiny in-memory db and a producer that records sends ────────────
interface Row {
  id: string;
  githubDeliveryId: string;
  event: string;
  payload: unknown;
  status: string;
  error: string | null;
  publishAttempts: number;
  lastPublishedAt: Date | null;
  createdAt: Date;
}

const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
const sent: Array<{ topic: string; key: string }> = [];
let selectResult: Row[] = [];
let kafkaDown = false;

vi.mock("@codeguard/db", () => {
  const select = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy"]) c[m] = () => c;
    c.limit = async () => selectResult;
    return c;
  };
  const update = () => {
    let set: Record<string, unknown> = {};
    const c: Record<string, unknown> = {};
    c.set = (v: Record<string, unknown>) => ((set = v), c);
    c.where = async (cond: { id: string }) => void updates.push({ id: cond.id, set });
    return c;
  };
  return {
    db: { select, update },
    webhookEvents: { status: "status", error: "error", createdAt: "created_at", lastPublishedAt: "last_published_at", id: "id" },
    eq: (_col: unknown, id: string) => ({ id }),
    and: () => ({}),
    or: () => ({}),
    lt: () => ({}),
    gt: () => ({}),
    asc: () => ({}),
    isNotNull: () => ({}),
    sql: () => ({}),
  };
});
vi.mock("../../queue/kafkaClient.js", () => ({
  getWorkerProducer: async () => ({
    send: async ({ topic, messages }: { topic: string; messages: Array<{ key: string }> }) => {
      if (kafkaDown) throw new Error("broker unreachable");
      for (const m of messages) sent.push({ topic, key: m.key });
    },
  }),
}));

const { outboxKey, classifyOutboxRow, sweepOutbox } = await import("../webhookOutboxSweeper.js");

const NOW = Date.parse("2026-10-19T12:00:00Z");
const row = (over: Partial<Row> = {}): Row => ({
  id: "row-1",
  githubDeliveryId: "d-1",
  event: "pull_request",
  payload: { repository: { name: "api", owner: { login: "acme" } }, pull_request: { number: 7 } },
  status: "processing",
  error: null,
  publishAttempts: 1,
  lastPublishedAt: new Date(NOW - 30 * 60_000),
  createdAt: new Date(NOW - 31 * 60_000),
  ...over,
});

beforeEach(() => {
  updates.length = 0;
  sent.length = 0;
  selectResult = [];
  kafkaDown = false;
});

describe("outboxKey", () => {
  it("keys pull_request events by PR so one PR's events stay ordered", () => {
    const payload = { repository: { name: "API", owner: { login: "Acme" } }, pull_request: { number: 7 } };
    expect(outboxKey(payload, "pull_request", "d-1")).toBe("acme/api#7");
  });

  it("falls back to the repository, then the delivery id", () => {
    expect(outboxKey({ repository: { name: "api", owner: { login: "acme" } } }, "push", "d-2")).toBe("acme/api");
    expect(outboxKey({}, "installation", "d-3")).toBe("d-3");
  });
});

describe("classifyOutboxRow", () => {
  it("resends until the attempt limit, then abandons", () => {
    expect(classifyOutboxRow({ publishAttempts: 0 })).toBe("resend");
    expect(classifyOutboxRow({ publishAttempts: 4 })).toBe("resend");
    expect(classifyOutboxRow({ publishAttempts: 5 })).toBe("abandon");
  });
});

describe("sweepOutbox", () => {
  it("does nothing when no delivery is stuck", async () => {
    expect(await sweepOutbox(NOW)).toEqual({ republished: 0, abandoned: 0 });
    expect(sent).toHaveLength(0);
  });

  it("republishes a delivery stuck in 'processing' and counts the attempt", async () => {
    selectResult = [row({ publishAttempts: 1 })];
    expect(await sweepOutbox(NOW)).toEqual({ republished: 1, abandoned: 0 });
    expect(sent).toEqual([{ topic: "codeguard.webhook.received", key: "acme/api#7" }]);
    expect(updates[0]).toEqual({ id: "row-1", set: expect.objectContaining({ status: "processing", error: null, publishAttempts: 2, lastPublishedAt: new Date(NOW) }) });
  });

  it("also republishes a 'received' delivery the web app never managed to publish", async () => {
    selectResult = [row({ status: "received", error: "kafka publish failed — queued for retry", publishAttempts: 0, lastPublishedAt: null })];
    expect(await sweepOutbox(NOW)).toEqual({ republished: 1, abandoned: 0 });
    expect(updates[0].set).toMatchObject({ publishAttempts: 1 });
  });

  it("gives up on a delivery that was published too many times without finishing", async () => {
    selectResult = [row({ publishAttempts: 5 })];
    expect(await sweepOutbox(NOW)).toEqual({ republished: 0, abandoned: 1 });
    expect(sent).toHaveLength(0);
    expect(updates[0].set).toMatchObject({ status: "failed", error: expect.stringContaining("5 publish attempts") });
  });

  it("leaves the row untouched when Kafka is down, so the next sweep tries again", async () => {
    selectResult = [row()];
    kafkaDown = true;
    await expect(sweepOutbox(NOW)).rejects.toThrow("broker unreachable");
    expect(updates).toHaveLength(0);
  });
});
