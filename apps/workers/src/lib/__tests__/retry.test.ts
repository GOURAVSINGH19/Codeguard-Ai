import { describe, it, expect, vi } from "vitest";
import { withRetry, isTransientGitHubError } from "../retry.js";

const httpError = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, ...extra });

describe("isTransientGitHubError", () => {
  it("retries network errors, 5xx and 429", () => {
    expect(isTransientGitHubError(new Error("socket hang up"))).toBe(true);
    expect(isTransientGitHubError(httpError(502))).toBe(true);
    expect(isTransientGitHubError(httpError(429))).toBe(true);
  });

  it("retries a 403 only when it is a rate limit", () => {
    expect(isTransientGitHubError(httpError(403, { response: { headers: { "retry-after": "10" } } }))).toBe(true);
    expect(isTransientGitHubError(httpError(403, { response: { headers: { "x-ratelimit-remaining": "0" } } }))).toBe(true);
    expect(isTransientGitHubError(httpError(403))).toBe(false); // e.g. missing permission
  });

  it("does not retry errors that will fail the same way again", () => {
    for (const status of [401, 404, 422]) expect(isTransientGitHubError(httpError(status))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result without sleeping when the first try works", async () => {
    const sleep = vi.fn();
    await expect(withRetry(async () => "ok", { sleep })).resolves.toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient failure with exponential backoff, then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockRejectedValueOnce(httpError(503)).mockResolvedValue("done");
    await expect(withRetry(fn, { sleep, baseDelayMs: 100 })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it("gives up after the last attempt and throws the real error", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(500));
    await expect(withRetry(fn, { sleep: async () => {}, attempts: 3 })).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws a permanent error immediately", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(422));
    await expect(withRetry(fn, { sleep: async () => {} })).rejects.toMatchObject({ status: 422 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reports each retry", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(httpError(502)).mockResolvedValue(1);
    await withRetry(fn, { sleep: async () => {}, onRetry });
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ status: 502 }), 1, 1_000);
  });
});
