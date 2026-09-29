import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { MissingConfigError } from "@codeguard/config";

/**
 * Consistent API error handling.
 *
 * Internal details (LLM/GitHub/DB error bodies, stack traces) are logged with
 * a request id and NEVER returned to the browser. Clients get a short, safe
 * message plus the request id to quote in bug reports.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonError(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** GitHub (Octokit) errors carry a numeric `status`. */
function githubStatus(err: unknown): number | null {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" && (err as { name?: string })?.name === "HttpError" ? status : typeof status === "number" && (err as { request?: unknown }).request ? status : null;
}

export function handleApiError(err: unknown, context: string) {
  const requestId = randomUUID();

  if (err instanceof HttpError) {
    return jsonError(err.status, err.message, { code: err.code, requestId });
  }
  if (err instanceof MissingConfigError) {
    console.error(`[${context}] ${requestId} configuration error:`, err.message);
    return jsonError(503, "This feature is not configured on the server.", { requestId });
  }

  const gh = githubStatus(err);
  if (gh === 401 || gh === 403) {
    console.warn(`[${context}] ${requestId} GitHub ${gh}:`, (err as Error).message);
    return jsonError(403, "GitHub denied access. Check that the app is installed and your GitHub account has access to this repository.", { requestId });
  }
  if (gh === 404) {
    return jsonError(404, "Repository or pull request not found on GitHub.", { requestId });
  }
  if (gh === 422) {
    return jsonError(422, "GitHub rejected the request.", { requestId });
  }

  console.error(`[${context}] ${requestId}`, err);
  return jsonError(500, "Something went wrong. Please try again.", { requestId });
}

/** Clamp an integer query parameter into a safe range. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
