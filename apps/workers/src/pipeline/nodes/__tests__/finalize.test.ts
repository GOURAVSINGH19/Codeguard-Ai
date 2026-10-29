import { describe, it, expect, vi } from "vitest";

// finalize.ts pulls in the db, Kafka and the review engine; only the pure helper is under test.
vi.mock("@codeguard/db", () => ({}));
vi.mock("@codeguard/kafka", () => ({ TOPICS: {}, prMessageKey: () => "" }));
vi.mock("@codeguard/review-engine", () => ({}));
vi.mock("../../../queue/kafkaClient.js", () => ({ getWorkerProducer: vi.fn() }));
vi.mock("../../store.js", () => ({ patchReviewMetadata: vi.fn(), saveCompletedReview: vi.fn() }));

const { publishStatus } = await import("../finalize.js");

describe("publishStatus", () => {
  it("is 'published' only when the review and the Check Run both reached GitHub", () => {
    expect(publishStatus({})).toBe("published");
  });

  it("is 'partial' when only one of them failed", () => {
    expect(publishStatus({ error: "422 Unprocessable" })).toBe("partial");
    expect(publishStatus({ checkRunError: "403 Resource not accessible" })).toBe("partial");
  });

  it("is 'failed' when nothing reached the PR, so it is not mistaken for a clean review", () => {
    expect(publishStatus({ error: "502", checkRunError: "502" })).toBe("failed");
  });
});
