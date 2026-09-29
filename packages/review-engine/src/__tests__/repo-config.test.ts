import { describe, it, expect } from "vitest";
import { parseRepoConfig, createIgnoreMatcher, decideConclusion, DEFAULT_REPO_CONFIG } from "../repo-config";
import type { ReviewIssue } from "@codeguard/types";

const issue = (severity: ReviewIssue["severity"]): ReviewIssue => ({ severity, category: "bug", file: null, line: null, message: "m", suggestion: null });

describe("repo config", () => {
  it("parses a valid .codeguard.yml", () => {
    const { config, warning } = parseRepoConfig("ignore:\n  - docs/**\nfail_on: high\nmin_severity: medium\n");
    expect(warning).toBeUndefined();
    expect(config).toMatchObject({ ignore: ["docs/**"], fail_on: "high", min_severity: "medium" });
  });

  it("falls back to defaults with a warning for invalid files", () => {
    expect(parseRepoConfig("fail_on: sometimes").warning).toMatch(/invalid/);
    expect(parseRepoConfig(": : :").config).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("ignores lockfiles by default plus configured globs", () => {
    const ignored = createIgnoreMatcher(parseRepoConfig("ignore: ['docs/**']").config);
    expect(ignored("pnpm-lock.yaml")).toBe(true);
    expect(ignored("apps/web/package-lock.json")).toBe(true);
    expect(ignored("docs/guide.md")).toBe(true);
    expect(ignored("src/index.ts")).toBe(false);
  });

  it("decides the check conclusion from fail_on", () => {
    const cfg = parseRepoConfig("fail_on: high").config;
    expect(decideConclusion([], cfg)).toBe("success");
    expect(decideConclusion([issue("medium")], cfg)).toBe("neutral");
    expect(decideConclusion([issue("high")], cfg)).toBe("failure");
    expect(decideConclusion([issue("critical")], parseRepoConfig("fail_on: never").config)).toBe("neutral");
  });
});
