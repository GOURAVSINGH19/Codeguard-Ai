import type { PRFileInput } from "../diff";
import { makeFinding } from "./types";
import type { Finding } from "./types";

// ─── Stage 1: understand the change (deterministic parts) ────────────────────

export const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[^/]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/i;
const GENERATED_FILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$|\.min\.(js|css)$|\.snap$|(^|\/)(dist|build|vendor|generated|__generated__)\/|\.pb\.go$|_pb2\.py$|\/migrations\/meta\//;
const DOC_FILE = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;

export type FileKind = "test" | "generated" | "docs" | "source";

export function classifyFile(path: string): FileKind {
  if (GENERATED_FILE.test(path)) return "generated";
  if (TEST_FILE.test(path)) return "test";
  if (DOC_FILE.test(path)) return "docs";
  return "source";
}

// ── committer ──────────────────────────────────────────────────────────────

export interface CommitterInput {
  login: string | null;
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE… */
  association: string | null;
  isBot: boolean;
  /** Earlier PRs by this author in this repository that we know of. */
  priorPRs: number;
  /** Commit authors in the PR that differ from the PR author. */
  coAuthors: string[];
}

export type TrustLevel = "maintainer" | "regular" | "newcomer" | "bot";

export interface CommitterProfile {
  login: string | null;
  association: string | null;
  trust: TrustLevel;
  priorPRs: number;
  coAuthors: string[];
  /** Multiplier applied to the risk score (newcomers and bots get more scrutiny). */
  riskFactor: number;
}

export function analyzeCommitter(input: CommitterInput): CommitterProfile {
  const assoc = (input.association ?? "NONE").toUpperCase();
  let trust: TrustLevel;
  if (input.isBot) trust = "bot";
  else if (assoc === "OWNER" || assoc === "MEMBER" || assoc === "COLLABORATOR") trust = "maintainer";
  else if (assoc === "FIRST_TIME_CONTRIBUTOR" || assoc === "FIRST_TIMER" || input.priorPRs === 0) trust = "newcomer";
  else trust = "regular";

  const riskFactor = { maintainer: 1, regular: 1.1, newcomer: 1.3, bot: 1.15 }[trust];
  return { login: input.login, association: input.association, trust, priorPRs: input.priorPRs, coAuthors: input.coAuthors, riskFactor };
}

// ── volume ─────────────────────────────────────────────────────────────────

export type SizeBucket = "XS" | "S" | "M" | "L" | "XL" | "XXL";

export interface VolumeReport {
  files: number;
  additions: number;
  deletions: number;
  /** Lines changed excluding generated files and lockfiles. */
  meaningfulLines: number;
  byKind: Record<FileKind, { files: number; lines: number }>;
  size: SizeBucket;
}

export function sizeBucket(lines: number): SizeBucket {
  if (lines < 10) return "XS";
  if (lines < 100) return "S";
  if (lines < 400) return "M";
  if (lines < 1000) return "L";
  if (lines < 2500) return "XL";
  return "XXL";
}

export function analyzeVolume(files: PRFileInput[], maxChangedLines: number): { report: VolumeReport; findings: Finding[] } {
  const byKind: VolumeReport["byKind"] = {
    source: { files: 0, lines: 0 },
    test: { files: 0, lines: 0 },
    generated: { files: 0, lines: 0 },
    docs: { files: 0, lines: 0 },
  };
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    const kind = classifyFile(f.filename);
    byKind[kind].files++;
    byKind[kind].lines += f.additions + f.deletions;
    additions += f.additions;
    deletions += f.deletions;
  }
  const meaningfulLines = byKind.source.lines + byKind.test.lines + byKind.docs.lines;
  const report: VolumeReport = { files: files.length, additions, deletions, meaningfulLines, byKind, size: sizeBucket(meaningfulLines) };

  const findings: Finding[] = [];
  if (meaningfulLines > maxChangedLines) {
    findings.push(
      makeFinding({
        source: "volume",
        severity: meaningfulLines > maxChangedLines * 2 ? "medium" : "low",
        category: "maintainability",
        message: `This PR changes ${meaningfulLines} lines across ${files.length} files (size ${report.size}), above the ${maxChangedLines}-line limit. Large PRs are reviewed less thoroughly and are harder to revert.`,
        suggestion: "Split it into smaller PRs that can be reviewed and merged independently.",
        confidence: 1,
        ruleId: "volume/too-large",
        deterministic: true,
      })
    );
  }
  return { report, findings };
}

// ── cohesion ───────────────────────────────────────────────────────────────

export interface CohesionReport {
  /** Groups of changed source files that are connected by imports or share a directory. */
  clusters: string[][];
  /** Top-level areas touched (first two path segments). */
  areas: string[];
  /** 1 = one tightly related change, → 0 as unrelated groups multiply. */
  score: number;
}

function area(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0] : "(root)";
}

/**
 * Cluster the changed source files: two files belong together when one
 * imports the other (`linked`) or they live in the same directory.
 */
export function analyzeCohesion(changedFiles: string[], linked: (a: string, b: string) => boolean): { report: CohesionReport; findings: Finding[] } {
  const source = changedFiles.filter((f) => classifyFile(f) === "source");
  const parent = new Map(source.map((f) => [f, f]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const dir = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);

  for (let i = 0; i < source.length; i++) {
    for (let j = i + 1; j < source.length; j++) {
      const a = source[i];
      const b = source[j];
      if (dir(a) === dir(b) || linked(a, b) || linked(b, a)) union(a, b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const f of source) {
    const root = find(f);
    groups.set(root, [...(groups.get(root) ?? []), f]);
  }
  const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
  const areas = [...new Set(source.map(area))];
  const score = clusters.length <= 1 ? 1 : Math.max(0, 1 - (clusters.length - 1) / Math.max(3, source.length / 2));

  const findings: Finding[] = [];
  if (clusters.length >= 3 && areas.length >= 3) {
    findings.push(
      makeFinding({
        source: "cohesion",
        severity: "low",
        category: "maintainability",
        message: `The changed code falls into ${clusters.length} unrelated groups across ${areas.length} areas (${areas.slice(0, 5).join(", ")}). Mixing independent changes makes review and rollback harder.`,
        suggestion: "Move unrelated changes into separate PRs.",
        confidence: 0.7,
        ruleId: "cohesion/unrelated-changes",
        deterministic: true,
      })
    );
  }
  return { report: { clusters, areas, score }, findings };
}
