import {
  VerificationOutputSchema,
  aggregateFindings,
  applyFindingVerdicts,
  buildContextPacks,
  buildVerifyMessages,
  deduplicateFindings,
  filterForReport,
  planVerification,
  renderPack,
} from "@codeguard/review-engine";
import type { PipelineStep } from "@codeguard/review-engine";
import type { ReviewRunState } from "../state.js";

/**
 * Findings nodes: aggregate → deduplicate → plan → verify. Kept free of the
 * database, Kafka and GitHub so the eval harness can run them offline.
 */
type Step = PipelineStep<ReviewRunState>;

export const aggregateFindingsNode: Step = {
  name: "aggregate_findings",
  async run(s) {
    s.aggregated = aggregateFindings(Object.values(s.findingsBySource), new Set(s.allFiles.map((f) => f.filename)));
  },
};

export const deduplicateFindingsNode: Step = {
  name: "deduplicate_findings",
  async run(s) {
    const { findings, removed } = deduplicateFindings(s.aggregated);
    s.deduplicated = findings;
    s.duplicatesRemoved = removed;
  },
};

export const verificationPlanner: Step = {
  name: "verification_planner",
  async run(s) {
    s.plan = planVerification(s.deduplicated, s.config);
  },
};

/**
 * A second model, with no stake in the findings, checks each one against the
 * diff. If it fails, findings are kept unverified (precision drops, the
 * review is not lost).
 */
export const independentVerify: Step = {
  name: "independent_verify",
  async run(s) {
    const plan = s.plan!;
    let checked = plan.verify.map((f) => ({ ...f, verification: "unverified" as const }));
    if (plan.verify.length > 0) {
      try {
        s.packs ??= buildContextPacks({ files: s.files });
        const files = [...new Set(plan.verify.map((f) => f.file).filter((f): f is string => Boolean(f)))];
        const diff = renderPack(s.packs.verify, s.files, files);
        const output = await s.llm.json(buildVerifyMessages({ diff: diff.text, relatedCode: s.packs.verify.relatedCode, issues: plan.verify }), VerificationOutputSchema);
        const result = applyFindingVerdicts(plan.verify, output);
        checked = result.findings.map((f) => ({ ...f, verification: f.verification ?? "unverified" })) as typeof checked;
        s.verification = {
          status: "verified",
          confirmed: result.confirmed,
          uncertain: result.uncertain,
          rejected: result.rejected.map((r) => ({ message: r.message, reason: r.reason })),
        };
      } catch (err) {
        const error = (err as Error).message;
        s.log.warn("verification failed, keeping unverified findings", { error });
        s.verification = { status: "failed", confirmed: 0, uncertain: 0, rejected: [], error: error.slice(0, 300) };
      }
    }
    const { kept, filtered } = filterForReport([...plan.trusted, ...checked, ...plan.unverified], s.config);
    s.findings = kept;
    s.filteredOut = [...plan.dropped, ...filtered];
  },
};
