import { describe, expect, it } from "vitest";
import { addedLines, buildDiffContext, commentableLines, numberPatch, parsePatch } from "../diff";

const PATCH = `@@ -10,4 +10,5 @@ export function verify(token) {
   const header = decode(token);
-  const ALG = "RS256";
+  const ALG = process.env.JWT_ALG ?? "none";
+  log(ALG);
   return check(header, ALG);
 }
\\ No newline at end of file`;

describe("parsePatch", () => {
  it("tracks new-file line numbers through context, removed and added lines", () => {
    const lines = parsePatch(PATCH);
    expect(lines.map((l) => [l.kind, l.newLine])).toEqual([
      [" ", 10],
      ["-", undefined],
      ["+", 11],
      ["+", 12],
      [" ", 13],
      [" ", 14],
    ]);
  });
});

describe("commentable / added lines", () => {
  it("allows comments on added + context lines (what GitHub accepts)", () => {
    expect([...commentableLines(PATCH)]).toEqual([10, 11, 12, 13, 14]);
  });
  it("added lines are only what this change introduced", () => {
    expect([...addedLines(PATCH)]).toEqual([11, 12]);
  });
  it("handles a missing patch (binary file)", () => {
    expect(commentableLines(undefined).size).toBe(0);
  });
});

describe("numberPatch", () => {
  it("prints the real line number on every added line so the model can cite it", () => {
    const out = numberPatch(PATCH);
    expect(out).toContain('+   11 |   const ALG = process.env.JWT_ALG ?? "none";');
    expect(out).toContain('-      |   const ALG = "RS256";');
  });
});

describe("buildDiffContext", () => {
  const file = (filename: string, patch: string | undefined, status = "modified") => ({ filename, status, additions: 1, deletions: 0, patch });

  it("skips lockfiles, deleted and binary files, with a reason", () => {
    const ctx = buildDiffContext(
      [file("src/a.ts", PATCH), file("pnpm-lock.yaml", PATCH), file("img.png", undefined), file("old.ts", PATCH, "removed")],
      10_000,
    );
    expect(ctx.included.map((f) => f.filename)).toEqual(["src/a.ts"]);
    expect(ctx.skipped.map((s) => s.filename).sort()).toEqual(["img.png", "old.ts", "pnpm-lock.yaml"]);
  });

  it("stops at the token budget and reports what was left out", () => {
    const big = "@@ -1,1 +1,400 @@\n" + Array.from({ length: 400 }, (_, i) => `+line ${i} ${"x".repeat(40)}`).join("\n");
    const ctx = buildDiffContext([file("small.ts", PATCH), file("big.ts", big)], 500);
    expect(ctx.included.map((f) => f.filename)).toEqual(["small.ts"]);
    expect(ctx.skipped).toContainEqual({ filename: "big.ts", reason: "over the token budget" });
  });
});
