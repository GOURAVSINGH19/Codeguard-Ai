/**
 * Retry an async call with exponential backoff, but only for errors that can
 * go away on their own (network trouble, 5xx, GitHub rate limits). A 401/404/422
 * will fail the same way every time, so it is thrown straight away.
 */
export interface RetryOptions {
  /** Total tries including the first (default 3). */
  attempts?: number;
  baseDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injected in tests so they don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Octokit errors carry `status`; a missing status means the request never got an answer. */
export function isTransientGitHubError(err: unknown): boolean {
  const e = err as { status?: number; message?: string; response?: { headers?: Record<string, string | undefined> } };
  if (typeof e?.status !== "number") return true;
  if (e.status >= 500 || e.status === 429) return true;
  if (e.status === 403) {
    const headers = e.response?.headers ?? {};
    return headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0" || /rate limit/i.test(e.message ?? "");
  }
  return false;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 1_000;
  const shouldRetry = opts.shouldRetry ?? isTransientGitHubError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      const delay = Math.min(15_000, base * 2 ** (attempt - 1));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
