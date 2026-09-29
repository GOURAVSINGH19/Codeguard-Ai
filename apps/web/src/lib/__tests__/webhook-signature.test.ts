import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifyGitHubSignature } from "../webhook-signature";

const body = JSON.stringify({ action: "opened" });
const sign = (secret: string, payload = body) => "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

describe("verifyGitHubSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifyGitHubSignature(body, sign("s3cret"), ["s3cret"])).toBe(true);
  });

  it("accepts any of several configured secrets (app + legacy)", () => {
    expect(verifyGitHubSignature(body, sign("legacy"), ["app", "legacy"])).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, or a missing header", () => {
    expect(verifyGitHubSignature(body, sign("other"), ["s3cret"])).toBe(false);
    expect(verifyGitHubSignature(body + " ", sign("s3cret"), ["s3cret"])).toBe(false);
    expect(verifyGitHubSignature(body, null, ["s3cret"])).toBe(false);
    expect(verifyGitHubSignature(body, "sha1=abc", ["s3cret"])).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(verifyGitHubSignature(body, sign("x"), [])).toBe(false);
  });
});
