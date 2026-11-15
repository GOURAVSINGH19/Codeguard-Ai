import { z } from "zod";
import { numberPatch, type DiffFile } from "../diff";
import type { LLMProvider } from "../llm/types";
import type { Finding } from "../schema";
import { completeJson } from "./llm-json";
import { VERIFIER_SYSTEM } from "./prompts";

/**
 * The verifier: a second, independent model call per batch of findings.
 * Reviewers are tuned to FIND problems, so some are false alarms. Checking a
 * claim against the real code is cheaper than making it, and every false
 * positive we drop protects developers' trust in the bot.
 */
const Verdicts = z.object({
  verdicts: z.array(
    z.object({
      id: z.coerce.number().int(),
      verdict: z.enum(["confirmed", "rejected", "uncertain"]),
      confidence: z.coerce.number().min(0).max(1),
      reason: z.string().max(600).default(""),
    }),
  ),
});

export interface VerifiedFinding extends Finding {
  verdict: "confirmed" | "uncertain";
  confidence: number;
}

export interface Rejected {
  file: string | null;
  line: number | null;
  severity: string;
  message: string;
  reason: string;
}

/** ±radius lines around `line` from the head version of the file (or from the patch as a fallback). */
export function codeWindow(file: DiffFile | undefined, content: string | undefined, line: number | null, radius = 15): string {
  if (content && line) {
    const lines = content.split("\n");
    const from = Math.max(0, line - 1 - radius);
    return lines
      .slice(from, line + radius)
      .map((l, i) => `${from + i + 1 === line ? ">" : " "}${String(from + i + 1).padStart(5)} | ${l}`)
      .join("\n");
  }
  return file?.patch ? numberPatch(file.patch).slice(0, 4000) : "(code not available)";
}

const fence = (s: string) => s.replace(/<\/?\s*untrusted[^>]*>/gi, "[tag removed]");

export async function verifyFindings(input: {
  provider: LLMProvider;
  findings: Finding[];
  files: DiffFile[];
  headContents: Map<string, string>;
  teamRules?: string;
  batchSize?: number;
}): Promise<{ kept: VerifiedFinding[]; rejected: Rejected[]; tokens: number; failedBatches: number }> {
  const byPath = new Map(input.files.map((f) => [f.filename, f]));
  const kept: VerifiedFinding[] = [];
  const rejected: Rejected[] = [];
  let tokens = 0;
  let failedBatches = 0;

  // ESLint results are facts about the code, not opinions: no model check needed.
  const toCheck = input.findings.filter((f) => f.source !== "eslint");
  for (const f of input.findings) if (f.source === "eslint") kept.push({ ...f, verdict: "confirmed", confidence: 0.8 });

  const size = input.batchSize ?? 8;
  const batches: Finding[][] = [];
  for (let i = 0; i < toCheck.length; i += size) batches.push(toCheck.slice(i, i + size));

  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const user = [
        input.teamRules ? `<team_rules>\n${input.teamRules}\n</team_rules>\n` : "",
        ...batch.map(
          (f, id) =>
            `<finding id="${id}">\nfile: ${f.file}:${f.line}\nseverity: ${f.severity} · category: ${f.category}\nclaim: <untrusted>${fence(f.message)}</untrusted>\n<code>\n${codeWindow(
              f.file ? byPath.get(f.file) : undefined,
              f.file ? input.headContents.get(f.file) : undefined,
              f.line,
            )}\n</code>\n</finding>`,
        ),
      ].join("\n");
      const { data, tokens: t } = await completeJson(input.provider, VERIFIER_SYSTEM, user, Verdicts, { temperature: 0 });
      return { batch, verdicts: data.verdicts, tokens: t };
    }),
  );

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      // Verifier down: keep the batch, but mark it uncertain so it can't block a merge on its own.
      failedBatches++;
      for (const f of batches[i]) kept.push({ ...f, verdict: "uncertain", confidence: 0.5 });
      return;
    }
    tokens += r.value.tokens;
    r.value.batch.forEach((f, id) => {
      const v = r.value.verdicts.find((x) => x.id === id);
      if (!v) return kept.push({ ...f, verdict: "uncertain", confidence: 0.5 });
      if (v.verdict === "rejected") {
        rejected.push({ file: f.file, line: f.line, severity: f.severity, message: f.message, reason: v.reason });
      } else {
        kept.push({ ...f, verdict: v.verdict, confidence: v.verdict === "uncertain" ? Math.min(v.confidence, 0.6) : v.confidence });
      }
    });
  });

  return { kept, rejected, tokens, failedBatches };
}
