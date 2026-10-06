import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SEVERITIES } from "@codeguard/types";
import type { ReviewIssue } from "@codeguard/types";

/**
 * Per-repository settings read from `.codeguard.yml` at the base branch.
 *
 * ```yaml
 * ignore:            # glob patterns never sent to the model
 *   - "**\/*.lock"
 *   - "dist/**"
 * min_severity: low  # issues below this are not posted
 * fail_on: critical  # check run fails at/above this severity ("never" = neutral only)
 * instructions: |    # team conventions added to the prompt
 *   We use Result<T, E> instead of throwing.
 * critical_paths:    # globs that raise the risk of a change
 *   - "src/billing/**"
 * skills:            # review checklists (auto-detected from the stack)
 *   enable: [kafka-consumer]
 *   disable: [react]
 * policy:
 *   max_changed_lines: 800   # larger PRs get a warning
 *   require_tests: warn      # off | warn | block — source changes without tests
 *   block_secrets: true      # a detected credential fails the check
 *   min_score: 6             # overall score below this fails the check (null = off)
 *   min_confidence: 0.5      # findings below this confidence are not posted
 * ```
 */
export const PolicyConfigSchema = z.object({
  max_changed_lines: z.number().int().positive().default(800),
  require_tests: z.enum(["off", "warn", "block"]).default("warn"),
  block_secrets: z.boolean().default(true),
  min_score: z.number().min(0).max(10).nullable().default(null),
  min_confidence: z.number().min(0).max(1).default(0.5),
});

export const RepoConfigSchema = z.object({
  ignore: z.array(z.string()).max(100).default([]),
  min_severity: z.enum(SEVERITIES).default("low"),
  fail_on: z.enum([...SEVERITIES, "never"] as const).default("critical"),
  instructions: z.string().max(4_000).optional(),
  critical_paths: z.array(z.string()).max(100).default([]),
  skills: z
    .object({
      enable: z.array(z.string()).max(50).default([]),
      disable: z.array(z.string()).max(50).default([]),
    })
    .prefault({}),
  policy: PolicyConfigSchema.prefault({}),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const DEFAULT_REPO_CONFIG: RepoConfig = RepoConfigSchema.parse({});

/** Files that are almost never worth an LLM's attention. */
export const DEFAULT_IGNORES = [
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/*.min.js",
  "**/*.map",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/*.snap",
];

export const CONFIG_FILE_PATH = ".codeguard.yml";

/** Parse `.codeguard.yml`. Invalid files fall back to defaults with a warning. */
export function parseRepoConfig(source: string | null | undefined): { config: RepoConfig; warning?: string } {
  if (!source) return { config: DEFAULT_REPO_CONFIG };
  try {
    const raw = parseYaml(source) ?? {};
    const parsed = RepoConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        config: DEFAULT_REPO_CONFIG,
        warning: `Ignored invalid ${CONFIG_FILE_PATH}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      };
    }
    return { config: parsed.data };
  } catch (err) {
    return { config: DEFAULT_REPO_CONFIG, warning: `Could not parse ${CONFIG_FILE_PATH}: ${(err as Error).message}` };
  }
}

export function createIgnoreMatcher(config: RepoConfig): (path: string) => boolean {
  return picomatch([...DEFAULT_IGNORES, ...config.ignore], { dot: true });
}

const RANK: Record<ReviewIssue["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function severityAtLeast(severity: ReviewIssue["severity"], threshold: ReviewIssue["severity"]): boolean {
  return RANK[severity] >= RANK[threshold];
}

export type CheckConclusion = "success" | "neutral" | "failure";

/** Policy decision for the GitHub Check Run. */
export function decideConclusion(issues: ReviewIssue[], config: RepoConfig): CheckConclusion {
  if (config.fail_on !== "never" && issues.some((i) => severityAtLeast(i.severity, config.fail_on as ReviewIssue["severity"]))) {
    return "failure";
  }
  return issues.length === 0 ? "success" : "neutral";
}
