import { describe, expect, it } from "vitest";
import { aliasesFromTsconfig, assessRisk, blastRadius, changedSymbols, chunkFile, findCallers, importsOf, resolveImport } from "../context";

describe("chunkFile", () => {
  it("cuts TS into one chunk per top-level declaration", () => {
    const src = [
      'import x from "x";',
      "",
      "/** Verify a token. */",
      "export function verifyJwt(t: string) {",
      "  return t.length > 0;",
      "}",
      "",
      "export class Session {",
      "  id = 1;",
      "}",
      "export const isAdmin = (u: { role: string }) => u.role === 'admin';",
    ].join("\n");
    const chunks = chunkFile("src/auth.ts", src);
    expect(chunks.map((c) => [c.symbol, c.startLine, c.endLine])).toEqual([
      ["verifyJwt", 3, 6], // includes the JSDoc
      ["Session", 8, 10],
      ["isAdmin", 11, 11],
    ]);
  });

  it("falls back to overlapping line windows for other languages", () => {
    const py = Array.from({ length: 130 }, (_, i) => `x${i} = ${i}`).join("\n");
    const chunks = chunkFile("app.py", py);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([[1, 60], [51, 110], [101, 130]]);
  });
});

describe("imports", () => {
  const all = new Set(["src/lib/jwt.ts", "src/lib/index.ts", "src/api/login.ts", "src/utils/x.tsx"]);

  it("resolves relative, index, alias and ESM .js-style imports", () => {
    expect(resolveImport("src/api/login.ts", "../lib/jwt", all)).toBe("src/lib/jwt.ts");
    expect(resolveImport("src/api/login.ts", "../lib", all)).toBe("src/lib/index.ts");
    expect(resolveImport("src/api/login.ts", "@/utils/x", all)).toBe("src/utils/x.tsx");
    expect(resolveImport("src/api/login.ts", "../lib/jwt.js", all)).toBe("src/lib/jwt.ts");
    expect(resolveImport("src/api/login.ts", "react", all)).toBeNull();
  });

  it("finds import, export-from and require edges", () => {
    const src = `import { a } from "../lib/jwt";\nexport * from "../lib";\nconst x = require("@/utils/x");\nimport React from "react";`;
    expect(importsOf("src/api/login.ts", src, all).sort()).toEqual(["src/lib/index.ts", "src/lib/jwt.ts", "src/utils/x.tsx"]);
  });

  it("reads aliases from tsconfig paths (comments allowed)", () => {
    const tsconfig = `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["./app/*"] } } }`;
    expect(aliasesFromTsconfig(tsconfig)).toEqual({ "@app/": "app/" });
  });
});

describe("blastRadius", () => {
  // a → b → c, d → c   (A → B means "A imports B")
  const files = [
    { path: "a.ts", imports: ["b.ts"] },
    { path: "b.ts", imports: ["c.ts"] },
    { path: "d.ts", imports: ["c.ts"] },
    { path: "c.ts", imports: [] },
  ];
  it("walks importers outward from the changed file", () => {
    expect(blastRadius(["c.ts"], files)).toEqual([
      { path: "b.ts", distance: 1, via: "c.ts" },
      { path: "d.ts", distance: 1, via: "c.ts" },
      { path: "a.ts", distance: 2, via: "c.ts" },
    ]);
  });
  it("respects maxDepth and never lists the changed files themselves", () => {
    expect(blastRadius(["c.ts"], files, 1).map((a) => a.path)).toEqual(["b.ts", "d.ts"]);
    expect(blastRadius(["a.ts"], files)).toEqual([]);
  });
});

describe("callers of changed functions", () => {
  const src = ["export function verifyJwt(t) {", "  return check(t);", "}", "", "export function other() {}"].join("\n");

  it("finds the function containing the changed line", () => {
    expect(changedSymbols("src/jwt.ts", src, new Set([2]))).toEqual(["verifyJwt"]);
    expect(changedSymbols("src/jwt.ts", src, new Set([5]))).toEqual(["other"]);
  });

  it("finds call sites with context, but not import lines", () => {
    const caller = ['import { verifyJwt } from "./jwt";', "", "export function mw(req) {", "  const user = verifyJwt(req.token);", "  return user;", "}"].join("\n");
    const hits = findCallers(["verifyJwt"], [{ path: "src/mw.ts", content: caller }], { radius: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ symbol: "verifyJwt", path: "src/mw.ts", line: 4 });
    expect(hits[0].snippet).toContain("const user = verifyJwt(req.token);");
  });
});

describe("assessRisk", () => {
  it("rates a one-line change to a widely used auth util above a big isolated change", () => {
    const hub = assessRisk({ changedPaths: ["src/auth/jwt.ts"], affectedCount: 37, maxFanIn: 14, linesChanged: 1, deletedTestFiles: 0 });
    const isolated = assessRisk({ changedPaths: ["scripts/report.ts"], affectedCount: 0, maxFanIn: 0, linesChanged: 300, deletedTestFiles: 0 });
    expect(hub.score).toBeGreaterThan(isolated.score);
    expect(hub.level).toBe("critical");
    expect(hub.factors.join(" ")).toContain("37 file(s) depend");
  });
});
