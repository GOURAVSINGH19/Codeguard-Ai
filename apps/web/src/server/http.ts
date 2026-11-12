import { randomUUID } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { MissingConfigError } from "@codeguard/config";

/**
 * Shared helpers for API route handlers.
 *
 * Errors meant for the browser are thrown as HttpError (status + safe message).
 * Anything else is logged with a request id and returned as a generic 500, so
 * internal details (GitHub/DB error bodies, stack traces) never reach the client.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The signed-in Clerk user id, or a 401. (proxy.ts already blocks anonymous requests; this is the second lock.) */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new HttpError(401, "Not signed in");
  return userId;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const requestId = randomUUID();
  if (err instanceof MissingConfigError) {
    console.error(`[api] ${requestId} server misconfigured:\n${err.message}`);
    return Response.json({ error: "Server is not configured", requestId }, { status: 500 });
  }
  console.error(`[api] ${requestId}`, err);
  return Response.json({ error: "Something went wrong", requestId }, { status: 500 });
}

/** Wrap a route handler so thrown errors become safe JSON responses. */
export function withErrors<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Parse a positive integer query param with a default and an upper bound. */
export function intParam(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
