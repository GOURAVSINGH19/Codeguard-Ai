import type { Octokit } from "octokit";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import {
  DEFAULT_REPO_CONFIG,
  type AlignmentResult,
  type AssuranceDecision,
  type BlastRadiusReport,
  type BusinessIntent,
  type CheckResult,
  type CohesionReport,
  type CommitterProfile,
  type ContextPack,
  type CriticalityReport,
  type Finding,
  type FindingSource,
  type Insights,
  type NodeTrace,
  type PackStage,
  type PolicyResult,
  type PRFileInput,
  type RepoConfig,
  type ResolvedSkills,
  type RiskAssessment,
  type Scorecard,
  type StructuredLLM,
  type TechnologyProfile,
  type TestingReport,
  type VerificationPlan,
  type VolumeReport,
} from "@codeguard/review-engine";
import type { DependencyGraph } from "../analyzers/DependencyGraph.js";
import type { Logger } from "../lib/logger.js";

export type PullRequestData = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];

export interface ChangedSymbol {
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/**
 * Everything one review run knows. Each node reads what earlier nodes wrote
 * and fills its own fields. Fields of optional nodes start with safe defaults,
 * so a failed optional node degrades the review instead of breaking it.
 */
export interface ReviewRunState {
  event: ReviewRequestedEvent;
  log: Logger;
  /** Set to end the run early without an error (duplicate, closed PR…). */
  stop: string | null;

  // ── initialize_run ──
  octokit: Octokit;
  llm: StructuredLLM;
  pr: PullRequestData;
  repositoryId: string;
  pullRequestId: string;
  headSha: string;
  publishToGitHub: boolean;

  // ── validate_event ──
  reviewId: string | null;
  /** Head SHA of the last completed review on this PR; diff is taken from here when set. */
  reviewBaseSha: string | null;

  // ── snapshot_repository ──
  treePaths: string[];
  treeTruncated: boolean;
  manifests: Record<string, string>;
  config: RepoConfig;

  // ── collect_pr_context ──
  allFiles: PRFileInput[];
  /** Files this run reviews (incremental subset, ignores removed). */
  files: PRFileInput[];
  ignoredFiles: string[];
  incremental: boolean;
  /** Inline-commentable lines per file, from the FULL PR diff. */
  commentable: Map<string, Set<number>>;
  commits: Array<{ sha: string; message: string; author: string | null }>;
  checks: CheckResult[];
  /** Head-commit contents of changed files (bounded). */
  headContents: Map<string, string>;

  // ── collect_business_context ──
  linkedIssues: Array<{ number: number; title: string; body: string | null }>;
  labels: string[];
  priorPRsByAuthor: number;

  // ── detect_technology / resolve_skills ──
  tech: TechnologyProfile;
  skills: ResolvedSkills;

  // ── build_context_packs ──
  packs: Record<PackStage, ContextPack> | null;
  /** Deterministic security findings (computed early; packs prioritise their files). */
  securityScan: Finding[];

  // ── build_software_graph ──
  graph: DependencyGraph | null;
  graphAvailable: boolean;
  changedSymbols: ChangedSymbol[];

  // ── extract_business_intent ──
  intent: BusinessIntent | null;

  // ── Stage 1 ──
  committer: CommitterProfile;
  alignment: AlignmentResult | null;
  volume: VolumeReport | null;
  cohesion: CohesionReport;

  // ── Stage 2 ──
  blast: BlastRadiusReport;
  criticality: CriticalityReport;
  risk: RiskAssessment | null;

  // ── Stage 3 + all stages ──
  findingsBySource: Partial<Record<FindingSource, Finding[]>>;
  stageSummaries: Partial<Record<"quality" | "security" | "testing", string>>;
  testing: TestingReport | null;

  // ── aggregation / verification ──
  aggregated: Finding[];
  deduplicated: Finding[];
  duplicatesRemoved: number;
  plan: VerificationPlan | null;
  verification: { status: "verified" | "skipped" | "failed"; confirmed: number; uncertain: number; rejected: Array<{ message: string; reason: string }>; error?: string };
  findings: Finding[];
  filteredOut: Finding[];

  // ── scoring / decision / report ──
  scorecard: Scorecard | null;
  policies: PolicyResult[];
  decision: AssuranceDecision | null;
  insights: Insights | null;

  // ── publish_report ──
  published: boolean;
  githubReview: { id: number; url: string; mode: string; inlineCount: number } | null;
  trace: NodeTrace[];
  startedAt: number;
}

export function emptyTechnology(): TechnologyProfile {
  return { languages: [], frameworks: [], testFrameworks: [], packageManagers: [], monorepo: false, pathAliases: {}, workspacePackages: {} };
}

/** Defaults for every field a node fills, so optional failures degrade gracefully. */
export function initialState(event: ReviewRequestedEvent, log: Logger): ReviewRunState {
  return {
    event,
    log,
    stop: null,
    octokit: undefined as unknown as Octokit,
    llm: undefined as unknown as StructuredLLM,
    pr: undefined as unknown as PullRequestData,
    repositoryId: "",
    pullRequestId: "",
    headSha: "",
    publishToGitHub: event.publishToGitHub ?? event.triggeredBy === "webhook",
    reviewId: null,
    reviewBaseSha: null,
    treePaths: [],
    treeTruncated: false,
    manifests: {},
    config: DEFAULT_REPO_CONFIG,
    allFiles: [],
    files: [],
    ignoredFiles: [],
    incremental: false,
    commentable: new Map(),
    commits: [],
    checks: [],
    headContents: new Map(),
    linkedIssues: [],
    labels: [],
    priorPRsByAuthor: 0,
    tech: emptyTechnology(),
    skills: { quality: [], security: [], testing: [], ids: [] },
    packs: null,
    securityScan: [],
    graph: null,
    graphAvailable: false,
    changedSymbols: [],
    intent: null,
    committer: { login: null, association: null, trust: "regular", priorPRs: 0, coAuthors: [], riskFactor: 1 },
    alignment: null,
    volume: null,
    cohesion: { clusters: [], areas: [], score: 1 },
    blast: { dependents: [], directCount: 0, transitiveCount: 0, hotspots: [], graphAvailable: false },
    criticality: { level: "low", score: 0, areas: [], criticalFiles: [] },
    risk: null,
    findingsBySource: {},
    stageSummaries: {},
    testing: null,
    aggregated: [],
    deduplicated: [],
    duplicatesRemoved: 0,
    plan: null,
    verification: { status: "skipped", confirmed: 0, uncertain: 0, rejected: [] },
    findings: [],
    filteredOut: [],
    scorecard: null,
    policies: [],
    decision: null,
    insights: null,
    published: false,
    githubReview: null,
    trace: [],
    startedAt: Date.now(),
  };
}
