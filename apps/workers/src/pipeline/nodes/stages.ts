import {
  AlignmentSchema,
  StageReviewSchema,
  analyzeBlastRadius,
  analyzeCohesion,
  analyzeCommitter,
  analyzeCriticality,
  analyzeTesting,
  analyzeVolume,
  assessRisk,
  buildAlignMessages,
  buildContextPacks,
  buildStageReviewMessages,
  classifyFile,
  fileSummary,
  formatSkills,
  makeFinding,
  normalizeStageCategory,
  renderPack,
} from "@codeguard/review-engine";
import type { ContextPack, Finding, PackStage, PipelineGroup, PipelineStep, ReviewerStage } from "@codeguard/review-engine";
import type { ReviewRunState } from "../state.js";

type Step = PipelineStep<ReviewRunState>;
type Group = PipelineGroup<ReviewRunState>;

function pack(s: ReviewRunState, stage: PackStage): ContextPack {
  s.packs ??= buildContextPacks({ files: s.files });
  return s.packs[stage];
}

function hotspotFiles(s: ReviewRunState): string[] {
  return s.blast.hotspots.map((h) => h.path);
}

// ═══ STAGE 1 · UNDERSTAND THE CHANGE ════════════════════════════════════════

const committer: Step = {
  name: "committer",
  optional: true,
  async run(s) {
    const login = s.pr.user?.login ?? null;
    s.committer = analyzeCommitter({
      login,
      association: s.pr.author_association ?? null,
      isBot: s.pr.user?.type === "Bot" || Boolean(login?.endsWith("[bot]")),
      priorPRs: s.priorPRsByAuthor,
      coAuthors: [...new Set(s.commits.map((c) => c.author).filter((a): a is string => Boolean(a) && a !== login))],
    });
  },
};

/** Does the diff do what the PR says? Skipped when the PR states no intent. */
const align: Step = {
  name: "align",
  optional: true,
  async run(s) {
    if (!s.intent?.stated || s.files.length === 0) return;
    const diff = renderPack(pack(s, "align"), s.files);
    const result = await s.llm.json(buildAlignMessages({ intent: s.intent, diff: diff.text, fileSummary: fileSummary(s.files) }), AlignmentSchema);
    s.alignment = result;
    const toFinding = (kind: "gap" | "unexplained") => (g: (typeof result.gaps)[number]) =>
      makeFinding({
        source: "align",
        // Intent mismatches are worth a look, never a blocker on their own.
        severity: g.severity === "critical" || g.severity === "high" ? "medium" : g.severity,
        category: "maintainability",
        file: g.file,
        message: kind === "gap" ? `Stated intent not fully implemented: ${g.message}` : `Change not explained by the PR description: ${g.message}`,
        confidence: 0.6,
        deterministic: false,
      });
    s.findingsBySource.align = [...result.gaps.map(toFinding("gap")), ...result.unexplained.map(toFinding("unexplained"))];
  },
};

/** Size is judged on the whole PR, not just the incremental slice. */
const volume: Step = {
  name: "volume",
  async run(s) {
    const { report, findings } = analyzeVolume(s.allFiles, s.config.policy.max_changed_lines);
    s.volume = report;
    s.findingsBySource.volume = findings;
  },
};

const cohesion: Step = {
  name: "cohesion",
  optional: true,
  async run(s) {
    const g = s.graph;
    const linked = (a: string, b: string) => Boolean(g?.getDirectDependencies(a).includes(b));
    const { report, findings } = analyzeCohesion(s.allFiles.map((f) => f.filename), linked);
    s.cohesion = report;
    s.findingsBySource.cohesion = findings;
  },
};

export const stage1: Group = { name: "stage_1_understand_change", parallel: [committer, align, volume, cohesion] };

// ═══ STAGE 2 · UNDERSTAND THE RISK ══════════════════════════════════════════

const blastRadius: Step = {
  name: "blast_radius",
  optional: true,
  async run(s) {
    const g = s.graph;
    s.blast = analyzeBlastRadius(s.allFiles.map((f) => f.filename), (p) => g?.getDirectImporters(p) ?? [], { graphAvailable: s.graphAvailable });
  },
};

const criticality: Step = {
  name: "criticality",
  optional: true,
  async run(s) {
    // Path-based pass; the join adds "widely imported" once blast radius is known.
    const { report, findings } = analyzeCriticality(s.allFiles.map((f) => f.filename), s.config.critical_paths, { ...s.blast, hotspots: [] });
    s.criticality = report;
    s.findingsBySource.criticality = findings;
  },
};

/** Fan-in: criticality with hub files, then one risk score for the change. */
const assessChangeRisk: Step = {
  name: "risk_assessment",
  async run(s) {
    if (s.blast.hotspots.some((h) => h.dependents >= 10)) {
      const { report, findings } = analyzeCriticality(s.allFiles.map((f) => f.filename), s.config.critical_paths, s.blast);
      s.criticality = report;
      s.findingsBySource.criticality = findings;
    }
    if (!s.volume) throw new Error("volume analysis missing");
    s.risk = assessRisk({ volume: s.volume, cohesion: s.cohesion, committer: s.committer, blast: s.blast, criticality: s.criticality });
  },
};

export const stage2: Group = { name: "stage_2_understand_risk", parallel: [blastRadius, criticality], join: assessChangeRisk };

// ═══ STAGE 3 · VALIDATE THE CHANGE ══════════════════════════════════════════

function stageNotes(s: ReviewRunState): string[] {
  const notes: string[] = [];
  if (s.incremental) notes.push(`Only commits pushed since ${s.reviewBaseSha!.slice(0, 7)} are shown; earlier changes were reviewed before.`);
  if (s.blast.dependents.length > 0) {
    notes.push(`Files that depend on the changed code (not shown): ${s.blast.dependents.slice(0, 8).map((d) => d.path).join(", ")}`);
  }
  if (s.changedSymbols.length > 0) {
    notes.push(`Functions/classes whose bodies changed: ${s.changedSymbols.slice(0, 15).map((c) => `${c.name} (${c.file})`).join(", ")}`);
  }
  if (s.risk && s.risk.level !== "low") notes.push(`Change risk is ${s.risk.level}: ${s.risk.factors.slice(0, 4).join("; ")}.`);
  return notes;
}

/** Run one model reviewer over its context pack and convert the output to findings. */
async function modelReview(s: ReviewRunState, stage: ReviewerStage, alreadyReported: Finding[] = []): Promise<Finding[]> {
  const p = pack(s, stage);
  const diff = renderPack(p, s.files, hotspotFiles(s));
  if (diff.includedFiles.length === 0) return [];
  const review = await s.llm.json(
    buildStageReviewMessages({
      stage,
      title: s.pr.title,
      intentSummary: s.intent?.stated ? s.intent.summary : null,
      diff: diff.text,
      relatedCode: p.relatedCode,
      skills: formatSkills(s.skills[stage]),
      instructions: s.config.instructions,
      notes: [...stageNotes(s), ...p.notes],
      alreadyReported: alreadyReported.map((f) => `${f.file ?? "PR"}${f.line ? `:${f.line}` : ""} — ${f.message}`),
    }),
    StageReviewSchema
  );
  s.stageSummaries[stage] = review.summary;
  return review.issues.map((i) =>
    makeFinding({
      source: stage,
      severity: i.severity,
      category: normalizeStageCategory(stage, i.category),
      file: i.file,
      line: i.line,
      message: i.message,
      suggestion: i.suggestion,
      confidence: i.confidence,
      deterministic: false,
    })
  );
}

const quality: Step = {
  name: "quality",
  optional: true,
  async run(s) {
    s.findingsBySource.quality = await modelReview(s, "quality");
  },
};

/** Deterministic scan always counts; the model reviewer is best-effort on top. */
const security: Step = {
  name: "security",
  async run(s) {
    s.findingsBySource.security = [...s.securityScan];
    try {
      s.findingsBySource.security.push(...(await modelReview(s, "security", s.securityScan)));
    } catch (err) {
      s.log.warn("security model review failed; keeping deterministic findings", { error: (err as Error).message });
    }
  },
};

const testing: Step = {
  name: "testing",
  async run(s) {
    const { report, findings } = analyzeTesting(s.files, s.checks, s.config.policy);
    s.testing = report;
    s.findingsBySource.testing = [...findings];
    // The model only looks at test quality when tests are actually in the diff.
    if (s.files.some((f) => classifyFile(f.filename) === "test")) {
      try {
        s.findingsBySource.testing.push(...(await modelReview(s, "testing", findings)));
      } catch (err) {
        s.log.warn("testing model review failed; keeping deterministic findings", { error: (err as Error).message });
      }
    }
  },
};

export const stage3: Group = { name: "stage_3_validate_change", parallel: [quality, security, testing] };
