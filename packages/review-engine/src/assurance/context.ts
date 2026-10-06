import { buildDiffContext } from "../diff";
import type { DiffContext, PRFileInput } from "../diff";
import { classifyFile } from "./change";

/**
 * build_context_packs: each model-driven stage gets its own slice of the PR
 * within its own budget, ordered by what matters to THAT stage — the security
 * reviewer sees auth and route code first, the testing reviewer sees tests
 * next to the code they cover, the quality reviewer sees the biggest risk
 * first. Related code (RAG + symbol usages) is attached per pack.
 */

export type PackStage = "align" | "quality" | "security" | "testing" | "verify";

export interface ContextPack {
  stage: PackStage;
  budgetChars: number;
  /** Files first in this order; the rest follow by size. */
  priorityOrder: string[];
  /** Related repository code, already formatted for the prompt. */
  relatedCode?: string;
  notes: string[];
}

const SECURITY_HINT = /(auth|login|session|token|password|secret|crypto|permission|role|admin|api\/|routes?\/|controllers?\/|handlers?\/|middleware|proxy|webhook|upload|sql|query|db|payment|billing|exec|shell|sanitize|cookie|cors|csrf|redirect)/i;

const BUDGETS: Record<PackStage, number> = { align: 16_000, quality: 28_000, security: 24_000, testing: 16_000, verify: 28_000 };

function bySize(files: PRFileInput[]): string[] {
  return [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).map((f) => f.filename);
}

export function buildContextPacks(input: {
  files: PRFileInput[];
  relatedCode?: string;
  symbolUsages?: string;
  /** Files flagged by deterministic security rules. */
  securityHotFiles?: string[];
}): Record<PackStage, ContextPack> {
  const sized = bySize(input.files);
  const tests = sized.filter((f) => classifyFile(f) === "test");
  const sources = sized.filter((f) => classifyFile(f) === "source");
  const securityFirst = [
    ...new Set([...(input.securityHotFiles ?? []), ...sources.filter((f) => SECURITY_HINT.test(f)), ...sources]),
  ];
  const related = [input.relatedCode, input.symbolUsages].filter(Boolean).join("\n\n") || undefined;

  return {
    align: { stage: "align", budgetChars: BUDGETS.align, priorityOrder: sources, notes: [] },
    quality: { stage: "quality", budgetChars: BUDGETS.quality, priorityOrder: sources, relatedCode: related, notes: [] },
    security: { stage: "security", budgetChars: BUDGETS.security, priorityOrder: securityFirst, relatedCode: input.relatedCode, notes: [] },
    testing: { stage: "testing", budgetChars: BUDGETS.testing, priorityOrder: [...tests, ...sources], notes: [] },
    verify: { stage: "verify", budgetChars: BUDGETS.verify, priorityOrder: sources, relatedCode: input.relatedCode, notes: [] },
  };
}

/**
 * Render a pack into an annotated diff. `boost` puts graph hotspots (files
 * many others depend on) right after the pack's own top priorities.
 */
export function renderPack(pack: ContextPack, files: PRFileInput[], boost: string[] = []): DiffContext {
  const head = pack.priorityOrder.slice(0, 3);
  const order = [...new Set([...head, ...boost, ...pack.priorityOrder])];
  return buildDiffContext(files, { budgetChars: pack.budgetChars, priorityOrder: order });
}

export function fileSummary(files: PRFileInput[], limit = 120): string {
  return files
    .slice(0, limit)
    .map((f) => `${f.status.padEnd(8)} +${f.additions} -${f.deletions}  ${f.filename}`)
    .join("\n");
}
