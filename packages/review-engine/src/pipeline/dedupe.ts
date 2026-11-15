import type { Finding } from "../schema";

const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);

/** Word overlap between two messages: |A∩B| / |A∪B|. */
export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Three reviewers often spot the same problem, each in its own words and often
 * under a different category ("bug" vs "security" for a missing await). Two
 * findings are duplicates when they're in the same file and:
 *   - on the SAME line, with the same category or messages sharing ≥ 20% of their words, or
 *   - within ±2 lines, with messages sharing ≥ 35% of their words.
 * Keep the more severe one. (Thresholds tuned on the eval set.)
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const kept: Finding[] = [];
  for (const f of sorted) {
    const dup = kept.find((k) => {
      if (k.file !== f.file) return false;
      const gap = Math.abs((k.line ?? 0) - (f.line ?? 0));
      const sim = similarity(k.message, f.message);
      if (gap === 0) return k.category === f.category || sim >= 0.2;
      return gap <= 2 && sim >= 0.35;
    });
    if (!dup) kept.push(f);
  }
  return kept;
}
