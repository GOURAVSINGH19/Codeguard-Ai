import { describe, expect, it, vi } from "vitest";
import { processMessage } from "../consumer";
import { ReviewRequested } from "../events";
import { prKey } from "../topics";

const valid = {
  type: "review.requested",
  installationId: 1,
  repoFullName: "octocat/hello",
  prNumber: 7,
  headSha: "a".repeat(40),
  trigger: "webhook",
  requestedBy: null,
};

const noWait = async () => {};

describe("processMessage", () => {
  it("runs the handler for a valid message", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const toDlq = vi.fn();
    const out = await processMessage(JSON.stringify(valid), { schema: ReviewRequested, handler }, { toDlq });
    expect(out).toBe("ok");
    expect(handler).toHaveBeenCalledWith(valid);
    expect(toDlq).not.toHaveBeenCalled();
  });

  it("sends bad JSON straight to the DLQ without calling the handler", async () => {
    const handler = vi.fn();
    const toDlq = vi.fn();
    expect(await processMessage("{oops", { schema: ReviewRequested, handler }, { toDlq })).toBe("dlq");
    expect(handler).not.toHaveBeenCalled();
    expect(toDlq).toHaveBeenCalledWith("invalid JSON");
  });

  it("sends a wrong shape to the DLQ (retrying can't fix bad data)", async () => {
    const handler = vi.fn();
    const toDlq = vi.fn();
    const bad = JSON.stringify({ ...valid, headSha: "short" });
    expect(await processMessage(bad, { schema: ReviewRequested, handler }, { toDlq })).toBe("dlq");
    expect(handler).not.toHaveBeenCalled();
  });

  it("retries a failing handler, then succeeds", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValue(undefined);
    const toDlq = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await processMessage(JSON.stringify(valid), { schema: ReviewRequested, handler }, { toDlq, backoff: noWait });
    expect(out).toBe("ok");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and sends to the DLQ instead of throwing", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("always broken"));
    const toDlq = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await processMessage(
      JSON.stringify(valid),
      { schema: ReviewRequested, handler, maxAttempts: 3 },
      { toDlq, backoff: noWait },
    );
    expect(out).toBe("dlq");
    expect(handler).toHaveBeenCalledTimes(3);
    expect(toDlq.mock.calls[0][0]).toContain("always broken");
  });
});

describe("prKey", () => {
  it("is the same for any casing, so one PR always lands on one partition", () => {
    expect(prKey("OctoCat/Hello", 7)).toBe(prKey("octocat/hello", 7));
  });
});

import { securityFromEnv } from "../client";

describe("securityFromEnv", () => {
  it("uses no TLS/SASL for local Docker", () => {
    expect(securityFromEnv({})).toEqual({});
  });
  it("turns on SASL over TLS for hosted Kafka (e.g. Aiven)", () => {
    expect(securityFromEnv({ KAFKA_SASL_USERNAME: "avnadmin", KAFKA_SASL_PASSWORD: "pw", KAFKA_CA_CERT: "-----BEGIN-----\nabc" })).toEqual({
      ssl: { rejectUnauthorized: true, ca: ["-----BEGIN-----\nabc"] },
      sasl: { mechanism: "scram-sha-256", username: "avnadmin", password: "pw" },
    });
  });
  it("supports TLS client certificates", () => {
    const out = securityFromEnv({ KAFKA_CLIENT_CERT: "C", KAFKA_CLIENT_KEY: "K" });
    expect(out).toEqual({ ssl: { rejectUnauthorized: true, cert: "C", key: "K" } });
  });
});
