import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ── Mocks: DB (records deliveries), Kafka (records sends), App service ──────
const deliveries = new Set<string>();
const sent: Array<{ key: string }> = [];
let kafkaDown = false;

vi.mock("@codeguard/db", () => {
  const chain = (result: () => unknown) => {
    const obj: Record<string, unknown> = {};
    for (const m of ["values", "onConflictDoNothing", "set", "where", "from", "limit"]) obj[m] = () => obj;
    obj.returning = async () => result();
    obj.then = (res: (v: unknown) => void) => Promise.resolve(undefined).then(res);
    obj.catch = () => obj;
    return obj;
  };
  return {
    db: {
      insert: () => {
        let id = "";
        const c = chain(() => (deliveries.has(id) ? [] : (deliveries.add(id), [{ id }])));
        c.values = (v: { githubDeliveryId: string }) => ((id = v.githubDeliveryId), c);
        return c;
      },
      update: () => chain(() => []),
      delete: () => chain(() => []),
      select: () => chain(() => []),
    },
    webhookEvents: { githubDeliveryId: "github_delivery_id", id: "id" },
    githubInstallations: {},
    repositories: {},
    eq: () => ({}),
    inArray: () => ({}),
  };
});

vi.mock("@codeguard/kafka", async (orig) => {
  const actual = await orig<typeof import("@codeguard/kafka")>();
  return {
    ...actual,
    getSharedProducer: async () => ({
      send: async ({ messages }: { messages: Array<{ key: string }> }) => {
        if (kafkaDown) throw new Error("broker unreachable");
        sent.push(...messages);
      },
    }),
  };
});

vi.mock("@/services/GitHubAppService", () => ({ GitHubAppService: { fromEnv: () => ({ handleInstallationEvent: vi.fn() }) } }));

const { handleGitHubWebhook } = await import("../github-webhook");
const { resetEnvCache } = await import("@codeguard/config");

const SECRET = "whsec";
const payload = JSON.stringify({ action: "opened", repository: { name: "api", owner: { login: "Acme" } }, pull_request: { number: 7 } });

function request(opts: { delivery?: string; signature?: string | null; body?: string } = {}) {
  const body = opts.body ?? payload;
  const headers: Record<string, string> = { "x-github-event": "pull_request", "x-github-delivery": opts.delivery ?? "d-1" };
  const sig = opts.signature === undefined ? "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex") : opts.signature;
  if (sig) headers["x-hub-signature-256"] = sig;
  return new Request("http://localhost/api/webhooks/github-app", { method: "POST", body, headers });
}

beforeEach(() => {
  deliveries.clear();
  sent.length = 0;
  kafkaDown = false;
  vi.stubEnv("NODE_ENV", "test");
  process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  resetEnvCache();
});

describe("handleGitHubWebhook", () => {
  it("publishes a verified delivery keyed by PR", async () => {
    const res = await handleGitHubWebhook(request(), "test");
    expect(res.status).toBe(200);
    expect(sent).toEqual([expect.objectContaining({ key: "acme/api#7" })]);
  });

  it("rejects an invalid signature", async () => {
    const res = await handleGitHubWebhook(request({ signature: "sha256=deadbeef" }), "test");
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("fails closed when no secret is configured outside development", async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    resetEnvCache();
    const res = await handleGitHubWebhook(request({ signature: null }), "test");
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(0);
  });

  it("drops a redelivered X-GitHub-Delivery (no duplicate review)", async () => {
    await handleGitHubWebhook(request({ delivery: "same" }), "test");
    const second = await handleGitHubWebhook(request({ delivery: "same" }), "test");
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(sent).toHaveLength(1);
  });

  it("still acknowledges GitHub when Kafka is down (outbox keeps the delivery)", async () => {
    kafkaDown = true;
    const res = await handleGitHubWebhook(request(), "test");
    expect(res.status).toBe(200);
    expect(deliveries.has("d-1")).toBe(true);
  });
});
