import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EvalCaseSchema, addedLineNumbers } from "../scoring.js";

/** The case files are test data: a typo in one would silently skew every metric. */
const CASES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../evals/cases");
const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));

/** Hunk header counts must agree with the body, or line numbers drift. */
function hunkProblems(patch: string): string[] {
  const problems: string[] = [];
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
    if (!h) continue;
    const wantOld = h[1] === undefined ? 1 : Number(h[1]);
    const wantNew = h[2] === undefined ? 1 : Number(h[2]);
    let oldN = 0;
    let newN = 0;
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("@@"); j++) {
      if (lines[j].startsWith("+")) newN++;
      else if (lines[j].startsWith("-")) oldN++;
      else {
        oldN++;
        newN++;
      }
    }
    if (oldN !== wantOld || newN !== wantNew) problems.push(`${lines[i]} → body has -${oldN} +${newN}`);
  }
  return problems;
}

describe("eval case files", () => {
  it("has a seed set with both buggy and clean PRs", () => {
    const cases = files.map((f) => EvalCaseSchema.parse(JSON.parse(readFileSync(join(CASES_DIR, f), "utf8"))));
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.some((c) => c.expected.length === 0)).toBe(true);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it.each(files)("%s is valid and points at added lines", (file) => {
    const c = EvalCaseSchema.parse(JSON.parse(readFileSync(join(CASES_DIR, file), "utf8")));
    expect(`${c.id}.json`).toBe(file);
    for (const f of c.files) expect(hunkProblems(f.patch)).toEqual([]);
    for (const exp of c.expected) {
      const target = c.files.find((f) => f.filename === exp.file);
      expect(target, `expected file ${exp.file} is not in the case`).toBeDefined();
      const added = addedLineNumbers(target!.patch);
      const overlaps = [...added].some((n) => n >= exp.lines[0] && n <= exp.lines[1]);
      expect(overlaps, `${exp.file}:${exp.lines.join("-")} covers no added line`).toBe(true);
    }
  });
});
