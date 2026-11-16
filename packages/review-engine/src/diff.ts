/**
 * Turning GitHub's per-file patches into something a model can review and
 * something GitHub will accept comments on.
 */

/** The subset of a GitHub "file in a diff" we use (pulls.listFiles / repos.compareCommits). */
export interface DiffFile {
  filename: string;
  status: string; // added | modified | removed | renamed | …
  additions: number;
  deletions: number;
  patch?: string; // missing for binary or very large files
}

export interface PatchLine {
  kind: "+" | "-" | " ";
  /** Line number in the NEW file (right side). Undefined for removed lines. */
  newLine?: number;
  text: string;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let next = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const kind = raw[0] as PatchLine["kind"];
    if (kind === "+") out.push({ kind, newLine: next++, text: raw.slice(1) });
    else if (kind === "-") out.push({ kind, text: raw.slice(1) });
    else out.push({ kind: " ", newLine: next++, text: raw.slice(1) });
  }
  return out;
}

/** Right-side lines GitHub accepts review comments on (added + context lines). */
export function commentableLines(patch: string | undefined): Set<number> {
  const s = new Set<number>();
  if (!patch) return s;
  for (const l of parsePatch(patch)) if (l.newLine !== undefined) s.add(l.newLine);
  return s;
}

/** Only the ADDED lines: what this change actually introduced. */
export function addedLines(patch: string | undefined): Set<number> {
  const s = new Set<number>();
  if (!patch) return s;
  for (const l of parsePatch(patch)) if (l.kind === "+" && l.newLine !== undefined) s.add(l.newLine);
  return s;
}

/**
 * Number every line so the model can CITE real line numbers instead of counting
 * (models are bad at counting, good at copying a number they can see):
 *   "+  42 | const ALG = …"   added
 *   "   43 | return x"        context
 *   "-     | old line"        removed (no new-file number)
 */
export function numberPatch(patch: string): string {
  return parsePatch(patch)
    .map((l) => `${l.kind}${l.newLine !== undefined ? String(l.newLine).padStart(5) : "     "} | ${l.text}`)
    .join("\n");
}

const SKIP = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|go\.sum)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap|svg|png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|eot|mp4|mp3)$/i,
  /(^|\/)(dist|build|out|coverage|node_modules|vendor|\.next)\//,
  /\.generated\.\w+$/,
];

export function isReviewable(f: DiffFile): boolean {
  return f.status !== "removed" && !!f.patch && !SKIP.some((re) => re.test(f.filename));
}

/** Rough token estimate (≈ 4 characters per token for code). Good enough for budgeting. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export interface DiffContext {
  text: string;
  included: DiffFile[];
  skipped: Array<{ filename: string; reason: string }>;
}

/**
 * Build the numbered diff for the prompt, within a token budget.
 * Smaller files first: more files fit, and big rewrites are usually less dense in bugs per line.
 */
export function buildDiffContext(files: DiffFile[], budgetTokens: number): DiffContext {
  const included: DiffFile[] = [];
  const skipped: DiffContext["skipped"] = [];
  const parts: string[] = [];
  let used = 0;

  const candidates = files.filter((f) => {
    if (isReviewable(f)) return true;
    skipped.push({ filename: f.filename, reason: f.status === "removed" ? "deleted" : !f.patch ? "binary or too large" : "generated/vendored" });
    return false;
  });
  candidates.sort((a, b) => (a.patch?.length ?? 0) - (b.patch?.length ?? 0));

  for (const f of candidates) {
    const block = `<file path="${f.filename}" status="${f.status}">\n${numberPatch(f.patch!)}\n</file>`;
    const cost = estimateTokens(block);
    if (used + cost > budgetTokens) {
      skipped.push({ filename: f.filename, reason: "over the token budget" });
      continue;
    }
    used += cost;
    included.push(f);
    parts.push(block);
  }
  return { text: parts.join("\n\n"), included, skipped };
}
