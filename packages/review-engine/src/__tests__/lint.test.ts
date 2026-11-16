import { describe, expect, it } from "vitest";
import { lintFiles } from "../lint";

describe("lintFiles", () => {
  it("finds real problems on added lines of TS code, from memory", async () => {
    const content = ["export function isAdmin(user: any) {", "  if (user = null) return false;", "  return user.role;", "}"].join("\n");
    const out = await lintFiles([{ path: "src/auth.ts", content, addedLines: new Set([2]) }]);
    expect(out).toContainEqual(expect.objectContaining({ file: "src/auth.ts", line: 2, ruleId: "no-cond-assign" }));
  }, 30_000);

  it("ignores problems on lines the PR didn't add", async () => {
    const content = "if (a = b) {}\n";
    const out = await lintFiles([{ path: "x.js", content, addedLines: new Set([99]) }]);
    expect(out).toEqual([]);
  }, 30_000);

  it("skips non-JS files", async () => {
    expect(await lintFiles([{ path: "README.md", content: "# hi", addedLines: new Set([1]) }])).toEqual([]);
  });
});
