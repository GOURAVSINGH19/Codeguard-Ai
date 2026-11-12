import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * "Did this request really come from GitHub?"
 *
 * GitHub sends X-Hub-Signature-256: sha256=<hex of HMAC-SHA256(secret, rawBody)>.
 * We compute the same HMAC; only someone who knows the secret can produce it,
 * and any change to the body changes it.
 *
 * - rawBody must be the exact bytes received (`await req.text()`), NOT re-serialised JSON.
 * - timingSafeEqual, not ===, so response timing can't leak how many bytes matched.
 * - No secret or no header → false. It fails CLOSED.
 */
export function verifyGitHubSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;

  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  // timingSafeEqual throws on different lengths, so check first (length isn't secret).
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Helper for tests and local tooling: the header GitHub would send for this body. */
export function signGitHubPayload(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
