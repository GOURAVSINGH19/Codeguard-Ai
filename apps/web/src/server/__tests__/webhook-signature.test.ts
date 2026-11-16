import { describe, expect, it } from "vitest";
import { signGitHubPayload, verifyGitHubSignature } from "../webhook-signature";

const SECRET = "test-webhook-secret-123456";
const BODY = JSON.stringify({ action: "opened", number: 7 });

describe("verifyGitHubSignature", () => {
  it("accepts the signature GitHub would send", () => {
    expect(verifyGitHubSignature(BODY, signGitHubPayload(BODY, SECRET), SECRET)).toBe(true);
  });

  it("rejects a body changed by one character", () => {
    const sig = signGitHubPayload(BODY, SECRET);
    expect(verifyGitHubSignature(BODY.replace("7", "8"), sig, SECRET)).toBe(false);
  });

  it("rejects re-serialised JSON (different bytes, same data)", () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyGitHubSignature(pretty, signGitHubPayload(BODY, SECRET), SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyGitHubSignature(BODY, signGitHubPayload(BODY, "wrong-secret-abcdefgh"), SECRET)).toBe(false);
  });

  it("fails closed on a missing header, wrong prefix or empty secret", () => {
    const sig = signGitHubPayload(BODY, SECRET);
    expect(verifyGitHubSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, sig.replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(verifyGitHubSignature(BODY, sig, "")).toBe(false);
  });

  it("returns false (does not throw) for a header of a different length", () => {
    expect(verifyGitHubSignature(BODY, "sha256=abc", SECRET)).toBe(false);
  });
});
