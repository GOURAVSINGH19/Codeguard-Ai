import { describe, expect, it } from "vitest";
import { decide, instructionsFor, isIgnored, parsePolicy } from "../policy";

const YAML = `
fail_on: [critical, high]
min_score: 70
ignore:
  - "**/*.generated.ts"
  - "docs/**"
path_instructions:
  - path: "src/auth/**"
    instructions: "Check token expiry."
`;

describe("parsePolicy", () => {
  it("parses a valid file", () => {
    const { policy, warnings, found } = parsePolicy(YAML);
    expect(found).toBe(true);
    expect(warnings).toEqual([]);
    expect(policy.fail_on).toEqual(["critical", "high"]);
    expect(policy.min_score).toBe(70);
  });

  it("uses defaults + a warning instead of crashing on bad config", () => {
    expect(parsePolicy("fail_on: [blocker]").warnings[0]).toContain("invalid settings");
    expect(parsePolicy("fail_on: [critical").warnings[0]).toContain("not valid YAML");
    expect(parsePolicy("fail_on: [blocker]").policy.fail_on).toEqual(["critical"]);
  });

  it("defaults when there is no file", () => {
    expect(parsePolicy(null)).toMatchObject({ found: false, policy: { fail_on: ["critical"], min_score: 0 } });
  });
});

describe("paths", () => {
  const { policy } = parsePolicy(YAML);
  it("ignores matching paths", () => {
    expect(isIgnored("src/api.generated.ts", policy)).toBe(true);
    expect(isIgnored("docs/intro.md", policy)).toBe(true);
    expect(isIgnored("src/api.ts", policy)).toBe(false);
  });
  it("returns only instructions that apply to changed files", () => {
    expect(instructionsFor(["src/auth/jwt.ts", "src/ui.tsx"], policy)).toEqual([
      { path: "src/auth/**", instructions: "Check token expiry.", files: ["src/auth/jwt.ts"] },
    ]);
    expect(instructionsFor(["src/ui.tsx"], policy)).toEqual([]);
  });
});

describe("decide", () => {
  const { policy } = parsePolicy(YAML);
  const high = { file: "src/a.ts", line: 3, severity: "high" as const, category: "security" };

  it("fails on a confirmed blocking finding, with a readable reason", () => {
    const d = decide({ policy, findings: [{ ...high, verdict: "confirmed" }], score: 85 });
    expect(d).toMatchObject({ verdict: "request_changes", conclusion: "failure" });
    expect(d.reasons).toEqual(["high security finding at src/a.ts:3"]);
  });

  it("never blocks on an UNCERTAIN finding", () => {
    expect(decide({ policy, findings: [{ ...high, verdict: "uncertain" }], score: 85 }).conclusion).toBe("success");
  });

  it("fails below min_score", () => {
    expect(decide({ policy, findings: [], score: 60 }).reasons).toEqual(["score 60 is below min_score 70"]);
  });

  it("approves a clean change and surfaces config warnings as 'warn' policies", () => {
    const d = decide({ policy, findings: [], score: 100, warnings: ["bad key"] });
    expect(d.verdict).toBe("approve");
    expect(d.policies.find((p) => p.status === "warn")?.message).toBe("bad key");
  });
});
