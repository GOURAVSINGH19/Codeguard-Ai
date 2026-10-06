import picomatch from "picomatch";
import { makeFinding } from "./types";
import type { Finding, RiskLevel } from "./types";
import type { CohesionReport, CommitterProfile, VolumeReport } from "./change";

// ─── Stage 2: understand the risk ────────────────────────────────────────────

// ── blast radius ───────────────────────────────────────────────────────────

export interface BlastRadiusReport {
  /** Files that import a changed file, by distance (1 = direct importer). */
  dependents: Array<{ path: string; distance: number }>;
  directCount: number;
  transitiveCount: number;
  /** Changed files with the most dependents first. */
  hotspots: Array<{ path: string; dependents: number }>;
  /** False when the dependency graph had no data (repo not indexed yet). */
  graphAvailable: boolean;
}

/**
 * BFS over reverse import edges from the changed files.
 * `importersOf(path)` returns the files that import `path`.
 */
export function analyzeBlastRadius(
  changedFiles: string[],
  importersOf: (path: string) => string[],
  opts: { maxDepth?: number; graphAvailable: boolean }
): BlastRadiusReport {
  const maxDepth = opts.maxDepth ?? 3;
  const changed = new Set(changedFiles);
  const distance = new Map<string, number>();
  let frontier = [...changed];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const importer of importersOf(f)) {
        if (changed.has(importer) || distance.has(importer)) continue;
        distance.set(importer, depth);
        next.push(importer);
      }
    }
    frontier = next;
  }
  const dependents = [...distance].map(([path, d]) => ({ path, distance: d })).sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
  const hotspots = changedFiles
    .map((path) => ({ path, dependents: importersOf(path).filter((i) => !changed.has(i)).length }))
    .filter((h) => h.dependents > 0)
    .sort((a, b) => b.dependents - a.dependents);

  return {
    dependents,
    directCount: dependents.filter((d) => d.distance === 1).length,
    transitiveCount: dependents.length,
    hotspots,
    graphAvailable: opts.graphAvailable,
  };
}

// ── criticality ────────────────────────────────────────────────────────────

const CRITICAL_AREAS: Array<{ id: string; label: string; pattern: RegExp; weight: number }> = [
  { id: "auth", label: "authentication / authorization", pattern: /(^|\/|[-_.])(auth|login|logout|session|oauth|sso|jwt|token|permission|rbac|acl|password|middleware|proxy)([-_./]|$)/i, weight: 3 },
  { id: "payments", label: "payments / billing", pattern: /(^|\/|[-_.])(payment|billing|invoice|checkout|stripe|subscription|pricing|wallet|ledger)/i, weight: 3 },
  { id: "crypto", label: "cryptography / secrets", pattern: /(^|\/|[-_.])(crypto|encrypt|decrypt|signature|hmac|secret|keys?|certificate|webhook-signature)([-_./]|$)/i, weight: 3 },
  { id: "data-schema", label: "database schema / migrations", pattern: /(^|\/)(migrations?|schema|prisma|drizzle|alembic|db\/)|\.sql$/i, weight: 2.5 },
  { id: "ci-infra", label: "CI / infrastructure", pattern: /(^|\/)(\.github\/workflows|\.circleci|terraform|k8s|kubernetes|helm|ansible)\/|Dockerfile|docker-compose|render\.yaml|vercel\.json|\.tf$/i, weight: 2 },
  { id: "config", label: "runtime configuration", pattern: /(^|\/)(config|env)[^/]*\.(ts|js|json|ya?ml|toml)$|\.env(\.|$)/i, weight: 1.5 },
  { id: "dependencies", label: "dependency manifests", pattern: /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile)$/i, weight: 1.5 },
  { id: "public-api", label: "public API surface", pattern: /(^|\/)(api|routes?|controllers?|handlers?|graphql|openapi)\//i, weight: 1.5 },
];

export interface CriticalityReport {
  level: RiskLevel;
  /** 0..10 */
  score: number;
  areas: Array<{ id: string; label: string; files: string[] }>;
  criticalFiles: string[];
}

export function analyzeCriticality(changedFiles: string[], criticalPathGlobs: string[], blast: BlastRadiusReport): { report: CriticalityReport; findings: Finding[] } {
  const custom = criticalPathGlobs.length > 0 ? picomatch(criticalPathGlobs, { dot: true }) : () => false;
  const areas = new Map<string, { id: string; label: string; files: string[]; weight: number }>();
  const add = (id: string, label: string, weight: number, file: string) => {
    const a = areas.get(id) ?? { id, label, files: [], weight };
    if (!a.files.includes(file)) a.files.push(file);
    areas.set(id, a);
  };

  for (const file of changedFiles) {
    if (custom(file)) add("repo-critical", "critical paths from .codeguard.yml", 3.5, file);
    for (const rule of CRITICAL_AREAS) if (rule.pattern.test(file)) add(rule.id, rule.label, rule.weight, file);
  }
  // A widely imported file is critical regardless of its name.
  for (const h of blast.hotspots) if (h.dependents >= 10) add("hub", "widely imported modules", 2, h.path);

  const weights = [...areas.values()].map((a) => a.weight).sort((a, b) => b - a);
  // Highest area counts fully, the others add diminishing weight.
  const score = Math.min(10, weights.reduce((sum, w, i) => sum + w / (i + 1), 0) * 1.4);
  const level: RiskLevel = score >= 7 ? "critical" : score >= 4.5 ? "high" : score >= 2 ? "medium" : "low";
  const criticalFiles = [...new Set([...areas.values()].flatMap((a) => a.files))];

  const findings: Finding[] = [];
  const custodial = areas.get("repo-critical");
  if (custodial) {
    findings.push(
      makeFinding({
        source: "criticality",
        severity: "low",
        category: "maintainability",
        message: `Touches paths the maintainers marked as critical: ${custodial.files.slice(0, 5).join(", ")}.`,
        suggestion: "Get a review from the owner of these paths before merging.",
        confidence: 1,
        ruleId: "criticality/critical-path",
        deterministic: true,
      })
    );
  }
  return { report: { level, score: round1(score), areas: [...areas.values()].map(({ id, label, files }) => ({ id, label, files })), criticalFiles }, findings };
}

// ── combined risk ──────────────────────────────────────────────────────────

export interface RiskAssessment {
  /** 0..100 */
  score: number;
  level: RiskLevel;
  factors: string[];
}

export function assessRisk(input: { volume: VolumeReport; cohesion: CohesionReport; committer: CommitterProfile; blast: BlastRadiusReport; criticality: CriticalityReport }): RiskAssessment {
  const factors: string[] = [];
  const sizePoints = { XS: 2, S: 6, M: 12, L: 20, XL: 28, XXL: 35 }[input.volume.size];
  if (sizePoints >= 20) factors.push(`large change (${input.volume.meaningfulLines} lines)`);

  const blastPoints = Math.min(25, input.blast.directCount * 1.5 + input.blast.transitiveCount * 0.4);
  if (blastPoints >= 10) factors.push(`${input.blast.transitiveCount} files depend on the changed code`);

  const critPoints = input.criticality.score * 3.5;
  for (const a of input.criticality.areas) factors.push(`touches ${a.label}`);

  const cohesionPoints = (1 - input.cohesion.score) * 10;
  if (cohesionPoints >= 5) factors.push("several unrelated changes in one PR");

  if (input.committer.trust === "newcomer") factors.push("first contribution from this author");

  const score = Math.round(Math.min(100, (sizePoints + blastPoints + critPoints + cohesionPoints) * input.committer.riskFactor));
  const level: RiskLevel = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";
  return { score, level, factors };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
