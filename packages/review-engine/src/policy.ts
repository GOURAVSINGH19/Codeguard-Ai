import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEVERITIES, type Severity } from "./schema";

/**
 * Policy-as-code: the team's rules in `.codeguard.yml`.
 *
 * The model gives OPINIONS; this file decides pass/fail. That makes the gate
 * predictable (same input → same verdict), explainable ("failed: 1 critical
 * security finding in src/auth/jwt.ts:4") and immune to prompt injection.
 *
 * ⚠️ Load it from the PR's BASE commit, never its head: otherwise a PR could
 * relax its own rules (fail_on: []) and pass.
 */
export const Policy = z.object({
  fail_on: z.array(z.enum(SEVERITIES)).default(["critical"]),
  min_score: z.number().int().min(0).max(100).default(0),
  ignore: z.array(z.string()).default([]),
  path_instructions: z
    .array(z.object({ path: z.string().min(1), instructions: z.string().min(1).max(1000) }))
    .max(50)
    .default([]),
});
export type Policy = z.infer<typeof Policy>;

export const DEFAULT_POLICY: Policy = Policy.parse({});

/** Parse YAML → validate. A broken file never blocks a review: defaults + a warning instead. */
export function parsePolicy(text: string | null): { policy: Policy; warnings: string[]; found: boolean } {
  if (text === null) return { policy: DEFAULT_POLICY, warnings: [], found: false };
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    return { policy: DEFAULT_POLICY, warnings: [`.codeguard.yml is not valid YAML (${(err as Error).message.split("\n")[0]}); using defaults`], found: true };
  }
  const parsed = Policy.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { policy: DEFAULT_POLICY, warnings: [`.codeguard.yml has invalid settings (${issues}); using defaults`], found: true };
  }
  return { policy: parsed.data, warnings: [], found: true };
}

const match = (path: string, pattern: string) => minimatch(path, pattern, { dot: true, matchBase: !pattern.includes("/") });

export function isIgnored(path: string, policy: Policy): boolean {
  return policy.ignore.some((p) => match(path, p));
}

/** Path instructions that apply to at least one changed file (with the files they apply to). */
export function instructionsFor(paths: string[], policy: Policy): Array<{ path: string; instructions: string; files: string[] }> {
  return policy.path_instructions
    .map((pi) => ({ ...pi, files: paths.filter((p) => match(p, pi.path)) }))
    .filter((pi) => pi.files.length > 0);
}

export interface PolicyCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface Decision {
  verdict: "approve" | "comment" | "request_changes";
  /** Check Run conclusion. */
  conclusion: "success" | "failure";
  headline: string;
  reasons: string[];
  policies: PolicyCheck[];
}

export interface DecidableFinding {
  file: string | null;
  line: number | null;
  severity: Severity;
  category: string;
  verdict?: "confirmed" | "uncertain";
}

/**
 * The gate. Only CONFIRMED findings can block: an "uncertain" finding is shown,
 * but never fails a build on its own.
 */
export function decide(input: { policy: Policy; findings: DecidableFinding[]; score: number; warnings?: string[] }): Decision {
  const { policy, findings, score } = input;
  const blocking = findings.filter((f) => f.verdict !== "uncertain" && policy.fail_on.includes(f.severity));
  const lowScore = score < policy.min_score;

  const policies: PolicyCheck[] = [
    {
      id: "fail_on",
      status: blocking.length ? "fail" : "pass",
      message: policy.fail_on.length
        ? blocking.length
          ? `${blocking.length} confirmed ${policy.fail_on.join("/")} finding(s)`
          : `no confirmed ${policy.fail_on.join("/")} findings`
        : "no severities block merging",
    },
    {
      id: "min_score",
      status: lowScore ? "fail" : "pass",
      message: policy.min_score ? `score ${score} vs minimum ${policy.min_score}` : "no minimum score",
    },
    ...(input.warnings ?? []).map((w, i) => ({ id: `config_${i + 1}`, status: "warn" as const, message: w })),
  ];

  const reasons = [
    ...blocking.map((f) => `${f.severity} ${f.category} finding at ${f.file ?? "PR"}${f.line ? `:${f.line}` : ""}`),
    ...(lowScore ? [`score ${score} is below min_score ${policy.min_score}`] : []),
  ];

  if (reasons.length) {
    return { verdict: "request_changes", conclusion: "failure", headline: `Blocked by policy: ${reasons[0]}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ""}`, reasons, policies };
  }
  if (findings.length) {
    return { verdict: "comment", conclusion: "success", headline: `Passes policy with ${findings.length} finding(s) worth a look`, reasons: [], policies };
  }
  return { verdict: "approve", conclusion: "success", headline: "Passes policy; no issues found", reasons: [], policies };
}
