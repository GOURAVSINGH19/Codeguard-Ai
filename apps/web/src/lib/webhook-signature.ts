import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify GitHub's `X-Hub-Signature-256` header against one or more secrets
 * (the GitHub App secret and, optionally, a legacy repository-webhook secret).
 * Constant-time comparison; any malformed header is simply "invalid".
 */
export function verifyGitHubSignature(rawBody: string, header: string | null, secrets: string[]): boolean {
  if (!header || !header.startsWith("sha256=") || secrets.length === 0) return false;
  const received = Buffer.from(header);
  return secrets.some((secret) => {
    const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
    return expected.length === received.length && timingSafeEqual(expected, received);
  });
}
