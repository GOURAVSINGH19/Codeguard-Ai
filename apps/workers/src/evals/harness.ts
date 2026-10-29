import {
  ImportResolver,
  IntentSchema,
  buildContextPacks,
  buildIntentMessages,
  detectTechnology,
  filterForReport,
  resolveSkills,
  runPipeline,
  scanRiskyPatterns,
  scanSecrets,
} from "@codeguard/review-engine";
import type { Finding, LLMUsage, NodeTrace, PipelineNode, PipelineStep, PRFileInput, StructuredLLM } from "@codeguard/review-engine";
import type { ReviewRequestedEvent } from "@codeguard/kafka";
import { stage1, stage2, stage3 } from "../pipeline/nodes/stages.js";
import { aggregateFindingsNode, deduplicateFindingsNode, independentVerify, verificationPlanner } from "../pipeline/nodes/findings.js";
import { codeContextStep } from "../pipeline/nodes/code-context.js";
import { DependencyGraph } from "../analyzers/DependencyGraph.js";
import { ImportExtractor } from "../analyzers/ImportExtractor.js";
import { initialState } from "../pipeline/state.js";
import type { PullRequestData, ReviewRunState } from "../pipeline/state.js";
import type { Logger } from "../lib/logger.js";
import { countChanges, scoreCase } from "./scoring.js";
import type { CaseScore, EvalCase } from "./scoring.js";

/**
 * Runs one eval case through the real review stages (stage 1 → independent
 * verification) with no database, Kafka or GitHub: the PR comes from the case
 * file and only the model is live.
 *
 * RAG is skipped (it needs embeddings of a real repo). When a case lists
 * `repoFiles`, the import graph and the code context (definitions, call
 * sites, breaking changes) are built from them, as on an indexed repo.
 */

export interface CaseRun {
  caseId: string;
  /** Scored on what would be posted after verification. */
  final: CaseScore;
  /** Scored on the same findings before the verifier ran: shows what verification is worth. */
  beforeVerify: CaseScore;
  verification: ReviewRunState["verification"];
  trace: NodeTrace[];
  usage: LLMUsage | null;
  llmCalls: number;
  durationMs: number;
  /** Set when a required node failed; the case then scores as all bugs missed. */
  error?: string;
  /**
   * Model calls that threw (rate limit, timeout, bad output). Some reviewers
   * swallow these and keep only deterministic findings, so a case with any
   * of them measures the outage, not the model: it is left out of the totals.
   */
  modelErrors: string[];
}

/** Error text is saved to result files: keep it short and drop account ids. */
export function redactError(message: string): string {
  return message.replace(/\b(org|organization|user|project|acct)_[A-Za-z0-9]+/g, "$1_***").slice(0, 200);
}

/** Same step as the worker's extract_business_intent, without the GitHub calls around it. */
const extractIntent: PipelineStep<ReviewRunState> = {
  name: "extract_business_intent",
  optional: true,
  async run(s) {
    s.intent = await s.llm.json(
      buildIntentMessages({
        title: s.pr.title,
        body: s.pr.body,
        commitMessages: [],
        linkedIssues: [],
        labels: [],
        branch: "eval",
        changedFiles: s.allFiles.map((f) => f.filename),
      }),
      IntentSchema
    );
  },
};

/** Import graph over the case's files, like the worker's build_software_graph. */
const buildCaseGraph: PipelineStep<ReviewRunState> = {
  name: "build_software_graph",
  optional: true,
  async run(s) {
    const repoFiles = (s as CaseState).caseRepoFiles;
    if (repoFiles.size === 0) return;
    const contents = new Map([...repoFiles, ...s.headContents]);
    const extractor = new ImportExtractor(new ImportResolver({ files: [...contents.keys()], pathAliases: {}, workspacePackages: {} }));
    const graph = new DependencyGraph();
    for (const [path, text] of contents) graph.addFile(path, extractor.extractImports(text, path));
    s.graph = graph;
    s.graphAvailable = true;
  },
};

/** The case's repo files stand in for GitHub. */
const buildCaseCodeContext = codeContextStep(async (s, paths) => {
  const repoFiles = (s as CaseState).caseRepoFiles;
  return new Map(paths.filter((p) => repoFiles.has(p)).map((p) => [p, repoFiles.get(p)!]));
});

type CaseState = ReviewRunState & { caseRepoFiles: Map<string, string> };

export const EVAL_WORKFLOW: PipelineNode<ReviewRunState>[] = [
  buildCaseGraph,
  buildCaseCodeContext,
  extractIntent,
  stage1,
  stage2,
  stage3,
  aggregateFindingsNode,
  deduplicateFindingsNode,
  verificationPlanner,
  independentVerify,
];

export function caseFiles(c: EvalCase): PRFileInput[] {
  return c.files.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch, ...countChanges(f.patch) }));
}

/** Pipeline state for a case, filled the way the worker's prepare nodes would. */
export function buildCaseState(c: EvalCase, llm: StructuredLLM, log: Logger): ReviewRunState {
  const event: ReviewRequestedEvent = {
    owner: "eval",
    repo: c.id,
    pullNumber: 1,
    userId: null,
    triggeredBy: "manual",
    headSha: "eval000",
    requestedAt: new Date().toISOString(),
  };
  const s = initialState(event, log);
  s.llm = llm;
  s.pr = {
    number: 1,
    title: c.title,
    body: c.body,
    user: { login: "eval-author", type: "User" },
    author_association: "MEMBER",
    head: { ref: "eval", sha: "eval000" },
    labels: [],
  } as unknown as PullRequestData;
  s.headSha = "eval000";

  const files = caseFiles(c);
  s.allFiles = files;
  s.files = files;
  s.headContents = new Map(c.files.filter((f) => f.content !== undefined).map((f) => [f.filename, f.content!]));
  (s as CaseState).caseRepoFiles = new Map((c.repoFiles ?? []).map((f) => [f.path, f.content]));
  s.tech = detectTechnology(files.map((f) => f.filename), {});
  s.skills = resolveSkills(s.tech, s.config.skills);
  s.securityScan = [...scanSecrets(files), ...scanRiskyPatterns(files)];
  s.packs = buildContextPacks({
    files,
    securityHotFiles: [...new Set(s.securityScan.map((f) => f.file).filter((f): f is string => Boolean(f)))],
  });
  return s;
}

/** What would have been posted if the verifier had not run (same filters as the report). */
function unverifiedReport(s: ReviewRunState): Finding[] {
  if (!s.plan) return [];
  return filterForReport([...s.plan.trusted, ...s.plan.verify, ...s.plan.unverified], s.config).kept;
}

export async function runCase(c: EvalCase, llm: StructuredLLM, log: Logger, tolerance?: number): Promise<CaseRun> {
  const s = buildCaseState(c, llm, log);
  const started = Date.now();
  let error: string | undefined;

  // Record every failed model call, including the ones a node catches itself.
  const modelErrors: string[] = [];
  const json = llm.json.bind(llm);
  llm.json = (async (messages, schema) => {
    try {
      return await json(messages, schema);
    } catch (err) {
      modelErrors.push(redactError((err as Error).message));
      throw err;
    }
  }) as StructuredLLM["json"];

  try {
    await runPipeline(EVAL_WORKFLOW, s, { onNodeEnd: (t) => void s.trace.push(t.error ? { ...t, error: redactError(t.error) } : t) });
  } catch (err) {
    error = redactError((err as Error).message);
  }
  if (s.verification.error) s.verification = { ...s.verification, error: redactError(s.verification.error) };
  return {
    modelErrors,
    caseId: c.id,
    final: scoreCase(c.id, error ? [] : s.findings, c.expected, tolerance),
    beforeVerify: scoreCase(c.id, error ? [] : unverifiedReport(s), c.expected, tolerance),
    verification: s.verification,
    trace: s.trace,
    usage: llm.usage,
    llmCalls: llm.calls,
    durationMs: Date.now() - started,
    error,
  };
}
