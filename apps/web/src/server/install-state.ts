import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * CSRF protection for the install flow.
 *
 * /install sets a random `state` in an httpOnly cookie and sends the same value
 * to GitHub. GitHub hands it back to /callback. If the two don't match, the
 * callback wasn't started by this browser, so we don't link anything.
 */
export const STATE_COOKIE = "cg_install_state";

export const stateCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const, // sent on the top-level redirect back from GitHub
  path: "/api/github/app",
  maxAge: 10 * 60, // 10 minutes to finish installing
};

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function stateMatches(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
