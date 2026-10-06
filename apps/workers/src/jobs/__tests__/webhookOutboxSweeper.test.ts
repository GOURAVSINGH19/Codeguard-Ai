import { describe, it, expect, vi } from "vitest";

vi.mock("@codeguard/db", () => ({}));
vi.mock("../../queue/kafkaClient.js", () => ({ getWorkerProducer: vi.fn() }));

const { outboxKey } = await import("../webhookOutboxSweeper.js");

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
