import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks: no real database or GitHub in unit tests ───────────────────────────
const returning = vi.fn();
const updateWhere = vi.fn();
vi.mock("@codeguard/db", () => ({
  db: {
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }),
    update: () => ({ set: () => ({ where: updateWhere }) }),
  },
  webhookEvents: { deliveryId: "delivery_id", id: "id" },
  eq: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

const publish = vi.fn();
vi.mock("@codeguard/kafka", () => ({
  publish: (...args: unknown[]) => publish(...args),
  TOPICS: { webhookReceived: "codeguard.webhook.received" },
  WebhookReceived: {},
}));

vi.mock("../installation-sync", () => ({
  upsertInstallation: vi.fn(),
  upsertRepositories: vi.fn(),
  deactivateRepositories: vi.fn(),
  setInstallationStatus: vi.fn(),
}));

import * as sync from "../installation-sync";
import { handleGitHubWebhook } from "../github-webhook";
import { signGitHubPayload } from "../webhook-signature";

const SECRET = "test-webhook-secret-123456";

function webhook(body: object, headers: Record<string, string | null> = {}) {
  const raw = JSON.stringify(body);
  const h: Record<string, string> = {};
  const all = {
    "x-hub-signature-256": signGitHubPayload(raw, SECRET),
    "x-github-delivery": "delivery-1",
    "x-github-event": "pull_request",
    ...headers,
  };
  for (const [k, v] of Object.entries(all)) if (v !== null) h[k] = v;
  return new Request("http://localhost/api/webhooks/github-app", { method: "POST", body: raw, headers: h });
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "codeguard-test",
    GITHUB_PRIVATE_KEY: "key",
    GITHUB_WEBHOOK_SECRET: SECRET,
  });
  returning.mockResolvedValue([{ id: "row-1" }]);
});

describe("handleGitHubWebhook", () => {
  it("rejects a request with no signature (401) and saves nothing", async () => {
    const res = await handleGitHubWebhook(webhook({ action: "opened" }, { "x-hub-signature-256": null }));
    expect(res.status).toBe(401);
    expect(returning).not.toHaveBeenCalled();
  });

  it("rejects missing GitHub headers (400)", async () => {
    const res = await handleGitHubWebhook(webhook({ action: "opened" }, { "x-github-delivery": null }));
    expect(res.status).toBe(400);
  });

  it("saves a new event, publishes it, marks it published and answers 200", async () => {
    publish.mockResolvedValue(undefined);
    const res = await handleGitHubWebhook(webhook({ action: "opened" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(returning).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][3]).toMatchObject({ webhookEventId: "row-1", deliveryId: "delivery-1" });
    expect(updateWhere).toHaveBeenCalledOnce(); // status = published
  });

  it("still answers 200 when Kafka is down; the row is left for the sweeper", async () => {
    publish.mockRejectedValue(new Error("Connection timeout"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleGitHubWebhook(webhook({ action: "opened" }));
    expect(res.status).toBe(200);
    expect(updateWhere).not.toHaveBeenCalled(); // not marked published
  });

  it("treats a redelivery (unique delivery id hit) as a harmless duplicate", async () => {
    returning.mockResolvedValue([]); // ON CONFLICT DO NOTHING inserted 0 rows
    const res = await handleGitHubWebhook(webhook({ action: "opened" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
    expect(sync.upsertInstallation).not.toHaveBeenCalled();
  });

  it("stores installation + repos on installation.created", async () => {
    const installation = { id: 42, account: { id: 7, login: "octocat", type: "User" } };
    const repositories = [{ id: 1, name: "hello", full_name: "octocat/hello", private: false }];
    const res = await handleGitHubWebhook(
      webhook({ action: "created", installation, repositories }, { "x-github-event": "installation" }),
    );
    expect(res.status).toBe(200);
    expect(sync.upsertInstallation).toHaveBeenCalledWith(installation, { status: "active" });
    expect(sync.upsertRepositories).toHaveBeenCalledWith(42, repositories);
  });

  it("still answers 200 when applying the event fails, and records the error", async () => {
    vi.mocked(sync.setInstallationStatus).mockRejectedValueOnce(new Error("boom"));
    const res = await handleGitHubWebhook(
      webhook({ action: "deleted", installation: { id: 42, account: null } }, { "x-github-event": "installation" }),
    );
    expect(res.status).toBe(200);
    expect(updateWhere).toHaveBeenCalledOnce();
  });

  it("returns 500 when the database is down, so GitHub shows a failed delivery", async () => {
    returning.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleGitHubWebhook(webhook({ action: "opened" }));
    expect(res.status).toBe(500);
  });
});
