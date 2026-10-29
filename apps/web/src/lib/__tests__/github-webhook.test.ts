import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

// ── Mocks: DB (records deliveries), Kafka (records sends), App service ──────
/** delivery id → status, standing in for the webhook_events table */
const deliveries = new Map<string, string>();
const sent: Array<{ key: string }> = [];
let kafkaDown = false;
let installSyncFails = false;

vi.mock("@codeguard/db", () => {
  const chain = (result: () => unknown, onWhere?: (cond: { value?: unknown }) => void) => {
    const obj: Record<string, unknown> = {};
    for (const m of ["values", "onConflictDoNothing", "from", "limit"]) obj[m] = () => obj;
    obj.set = (v: Record<string, unknown>) => ((obj._set = v), obj);
    obj.where = (cond: { value?: unknown }) => (onWhere?.(cond), obj);
    obj.returning = async () => result();
    obj.then = (res: (v: unknown) => void) => Promise.resolve(undefined).then(res);
    obj.catch = () => obj;
    return obj;
  };
  return {
    db: {
      insert: () => {
        let id = "";
        // New delivery → stored. Existing one → only a FAILED delivery is taken again.
        const claim = () => {
          const status = deliveries.get(id);
          if (status === undefined || status === "failed") {
            deliveries.set(id, "received");
            return [{ id }];
          }
          return [];
        };
        const c = chain(claim);
        c.values = (v: { githubDeliveryId: string }) => ((id = v.githubDeliveryId), c);
        c.onConflictDoUpdate = () => c;
        return c;
      },
      update: () => {
        const c = chain(
          () => [],
          (cond) => {
            const status = (c._set as { status?: string } | undefined)?.status;
            if (status && typeof cond.value === "string") deliveries.set(cond.value, status);
          }
        );
        return c;
      },
      delete: () => chain(() => []),
      select: () => chain(() => []),
    },
    webhookEvents: { githubDeliveryId: "github_delivery_id", id: "id", status: "status" },
    githubInstallations: {},
    repositories: {},
    eq: (_col: unknown, value: unknown) => ({ value }),
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

vi.mock("@/services/GitHubAppService", () => ({
  GitHubAppService: {
    fromEnv: () => ({
      handleInstallationEvent: async () => {
        if (installSyncFails) throw new Error("GitHub API unavailable");
      },
    }),
  },
}));

const { handleGitHubWebhook } = await import("../github-webhook");
const { resetEnvCache } = await import("@codeguard/config");

const SECRET = "whsec";
const payload = JSON.stringify({ action: "opened", repository: { name: "api", owner: { login: "Acme" } }, pull_request: { number: 7 } });

const installPayload = JSON.stringify({ action: "created", installation: { id: 99 }, repository: { name: "api", owner: { login: "Acme" } } });

function request(opts: { delivery?: string; signature?: string | null; body?: string; event?: string } = {}) {
  const body = opts.body ?? payload;
  const headers: Record<string, string> = { "x-github-event": opts.event ?? "pull_request", "x-github-delivery": opts.delivery ?? "d-1" };
  const sig = opts.signature === undefined ? "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex") : opts.signature;
  if (sig) headers["x-hub-signature-256"] = sig;
  return new Request("http://localhost/api/webhooks/github-app", { method: "POST", body, headers });
}

beforeEach(() => {
  deliveries.clear();
  sent.length = 0;
  kafkaDown = false;
  installSyncFails = false;
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

  it("only stores the delivery when the broker is private to the workers", async () => {
    vi.stubEnv("KAFKA_PUBLISH_FROM_WEB", "false");
    resetEnvCache();
    const res = await handleGitHubWebhook(request(), "test");
    expect(await res.json()).toMatchObject({ received: true, queued: true });
    expect(deliveries.has("d-1")).toBe(true);
    expect(sent).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("still acknowledges GitHub when Kafka is down (outbox keeps the delivery)", async () => {
    kafkaDown = true;
    const res = await handleGitHubWebhook(request(), "test");
    expect(res.status).toBe(200);
    expect(deliveries.has("d-1")).toBe(true);
  });

  describe("installation sync failure", () => {
    const install = (delivery: string) => request({ delivery, event: "installation", body: installPayload });

    it("fails the delivery with a 500 and publishes nothing", async () => {
      installSyncFails = true;
      const res = await handleGitHubWebhook(install("inst-1"), "test");
      expect(res.status).toBe(500);
      expect(deliveries.get("inst-1")).toBe("failed");
      expect(sent).toHaveLength(0);
    });

    it("lets GitHub's redelivery of that failed delivery run again", async () => {
      installSyncFails = true;
      await handleGitHubWebhook(install("inst-2"), "test");

      installSyncFails = false; // GitHub is back; someone clicks "Redeliver"
      const retry = await handleGitHubWebhook(install("inst-2"), "test");
      expect(retry.status).toBe(200);
      expect(await retry.json()).not.toMatchObject({ duplicate: true });
      expect(sent).toHaveLength(1);
    });

    it("still drops a redelivery of a delivery that already succeeded", async () => {
      await handleGitHubWebhook(install("inst-3"), "test");
      const again = await handleGitHubWebhook(install("inst-3"), "test");
      expect(await again.json()).toMatchObject({ duplicate: true });
      expect(sent).toHaveLength(1);
    });
  });
});
