import { describe, it, expect } from "vitest";
import { annotatePatch, buildDiffContext } from "../diff";

const PATCH = [
  "@@ -10,4 +10,5 @@ function load() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " return a;",
  "\\ No newline at end of file",
].join("\n");

describe("annotatePatch", () => {
  it("numbers added and context lines with their NEW-file line number", () => {
    const { text, commentableLines } = annotatePatch(PATCH);
    expect(text).toContain("   10   const a = 1;");
    expect(text).toContain("      - const b = 2;");
    expect(text).toContain("   11 + const b = 3;");
    expect(text).toContain("   12 + const c = 4;");
    expect(text).toContain("   13   return a;");
    expect(text).not.toContain("No newline");
    expect([...commentableLines]).toEqual([10, 11, 12, 13]);
  });

  it("handles several hunks", () => {
    const patch = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -50,0 +50,2 @@\n+x\n+y";
    expect([...annotatePatch(patch).commentableLines]).toEqual([1, 50, 51]);
  });
});

describe("buildDiffContext", () => {
  const file = (filename: string, size: number, patch: string | null = "@@ -1 +1 @@\n+" + "x".repeat(size)) => ({
    filename,
    status: "modified",
    additions: size,
    deletions: 0,
    patch,
  });

  it("keeps whole files and reports what did not fit", () => {
    const ctx = buildDiffContext([file("a.ts", 100), file("big.ts", 5_000), file("b.ts", 100)], { budgetChars: 1_000 });
    expect(ctx.includedFiles).toEqual(["a.ts", "b.ts"]);
    expect(ctx.excludedFiles).toEqual(["big.ts"]);
    expect(ctx.text).not.toContain("big.ts");
  });

  it("follows the priority order before size order", () => {
    const ctx = buildDiffContext([file("small.ts", 1), file("large.ts", 50)], { priorityOrder: ["small.ts"] });
    expect(ctx.includedFiles).toEqual(["small.ts", "large.ts"]);
  });

  it("lists files without a patch separately", () => {
    const ctx = buildDiffContext([file("logo.png", 0, null), file("a.ts", 3)]);
    expect(ctx.noPatchFiles).toEqual(["logo.png"]);
    expect(ctx.commentable.has("a.ts")).toBe(true);
  });

  it("escapes file names inside the XML-like wrapper", () => {
    const ctx = buildDiffContext([file('evil".ts', 1)]);
    expect(ctx.text).toContain('path="evil&quot;.ts"');
  });
});
