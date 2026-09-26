/**
 * Diff utilities.
 *
 * GitHub's `patch` strings contain hunk headers (`@@ -a,b +c,d @@`) but no
 * per-line numbers, so an LLM has to guess line numbers — which is why reviews
 * used to point at the wrong lines. We annotate every line with its NEW-file
 * line number and remember which lines GitHub will accept inline comments on.
 */

export interface PRFileInput {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null;
}

export interface AnnotatedPatch {
  /** Patch text with right-side line numbers in a left gutter. */
  text: string;
  /** New-file line numbers that appear in the diff (added or context lines). */
  commentableLines: Set<number>;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function annotatePatch(patch: string): AnnotatedPatch {
  const out: string[] = [];
  const commentableLines = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      out.push(raw);
      continue;
    }
    if (!inHunk) continue;

    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = raw[0];
    const code = raw.slice(1);
    if (marker === "+") {
      out.push(`${String(newLine).padStart(5)} + ${code}`);
      commentableLines.add(newLine);
      newLine++;
    } else if (marker === "-") {
      out.push(`${"".padStart(5)} - ${code}`);
    } else {
      // context line (leading space) or an empty line inside the hunk
      out.push(`${String(newLine).padStart(5)}   ${code}`);
      commentableLines.add(newLine);
      newLine++;
    }
  }

  return { text: out.join("\n"), commentableLines };
}

export interface DiffContextOptions {
  /** Max characters of annotated diff to send (default 24,000). */
  budgetChars?: number;
  /** Filenames in priority order (e.g. from the dependency-graph selector). */
  priorityOrder?: string[];
}

export interface DiffContext {
  text: string;
  includedFiles: string[];
  /** Changed files left out because of the budget. */
  excludedFiles: string[];
  /** Changed files GitHub gave no patch for (binary or too large). */
  noPatchFiles: string[];
  commentable: Map<string, Set<number>>;
}

export const DEFAULT_DIFF_BUDGET_CHARS = 24_000;

/**
 * Build the diff section of the prompt within a character budget. Whole files
 * are included or excluded (never cut mid-hunk) and exclusions are reported so
 * they can be logged and mentioned to the model.
 */
export function buildDiffContext(files: PRFileInput[], opts: DiffContextOptions = {}): DiffContext {
  const budget = opts.budgetChars ?? DEFAULT_DIFF_BUDGET_CHARS;
  const byName = new Map(files.map((f) => [f.filename, f]));

  const ordered: PRFileInput[] = [];
  const seen = new Set<string>();
  for (const name of opts.priorityOrder ?? []) {
    const f = byName.get(name);
    if (f && !seen.has(name)) {
      ordered.push(f);
      seen.add(name);
    }
  }
  const rest = files
    .filter((f) => !seen.has(f.filename))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  ordered.push(...rest);

  const sections: string[] = [];
  const includedFiles: string[] = [];
  const excludedFiles: string[] = [];
  const noPatchFiles: string[] = [];
  const commentable = new Map<string, Set<number>>();
  let used = 0;

  for (const file of ordered) {
    if (!file.patch) {
      noPatchFiles.push(file.filename);
      continue;
    }
    const annotated = annotatePatch(file.patch);
    const section =
      `<file path="${escapeAttr(file.filename)}" status="${escapeAttr(file.status)}" additions="${file.additions}" deletions="${file.deletions}">\n` +
      `${annotated.text}\n</file>`;

    if (used + section.length > budget) {
      excludedFiles.push(file.filename);
      continue;
    }
    sections.push(section);
    includedFiles.push(file.filename);
    commentable.set(file.filename, annotated.commentableLines);
    used += section.length;
  }

  return { text: sections.join("\n\n"), includedFiles, excludedFiles, noPatchFiles, commentable };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
