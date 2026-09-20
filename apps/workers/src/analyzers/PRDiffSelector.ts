import { DependencyGraph } from "./DependencyGraph.js";
import { ImportExtractor } from "./ImportExtractor.js";

export interface PRFile {
  filename: string;
  status: string;  // "added" | "modified" | "removed" | "renamed"
  additions: number;
  deletions: number;
  patch?: string;  // the actual diff patch text
}

export interface SelectedDiff {
  /** Final diff string to send to the AI, within the char budget */
  diffContext: string;
  /** Files included in the diff, in priority order */
  includedFiles: string[];
  /** Files excluded due to budget */
  excludedFiles: string[];
  /** Files transitively at risk but not in the diff */
  transitiveRiskFiles: string[];
  /** Whether the graph was used (false = graph unavailable, fell back to naive) */
  graphUsed: boolean;
}

const MAX_DIFF_CHARS = 12_000;

/**
 * PRDiffSelector
 *
 * Replaces the naive `.slice(0, 12_000)` truncation with a graph-aware selector.
 *
 * Algorithm:
 * 1. Build a DependencyGraph from the repository's source files
 * 2. For each PR file, find its blast radius (files that import it)
 * 3. Rank all files by risk score (direct changes > high-impact > distant)
 * 4. Fill the diff context budget (12,000 chars) from highest-risk files first
 * 5. Always include the full patch for directly-changed files before cut
 *
 * Why this is better than .slice():
 * - A 1-line change to a widely-imported utility scores higher than a
 *   200-line change to an isolated test file
 * - The AI sees complete file patches instead of truncated mid-function text
 * - The review mentions which high-risk files were excluded (context for the LLM)
 */
export class PRDiffSelector {
  private readonly extractor = new ImportExtractor();

  /**
   * Select the optimal subset of PR file patches to send to the AI.
   *
   * @param prFiles         All files changed in the PR (from GitHub API)
   * @param repoFileContents  Map of filePath → source content (for import extraction)
   *                          Can be partial — graph works with whatever is provided
   */
  select(
    prFiles: PRFile[],
    repoFileContents: Map<string, string>
  ): SelectedDiff {
    // ── 1. Build dependency graph from repo file contents ─────────────────
    const graph = new DependencyGraph();
    let graphUsed = false;

    if (repoFileContents.size > 0) {
      for (const [filePath, content] of repoFileContents) {
        const imports = this.extractor.extractImports(content, filePath);
        graph.addFile(filePath, imports);
      }
      graphUsed = true;
    }

    // ── 2. Build the changed files map (path → total lines changed) ───────
    const changedFilesMap = new Map<string, number>();
    for (const file of prFiles) {
      changedFilesMap.set(file.filename, file.additions + file.deletions);
    }

    // ── 3. Rank files by risk ─────────────────────────────────────────────
    let rankedFiles: string[];

    if (graphUsed && graph.size > 0) {
      const ranked = graph.rankFilesForReview(changedFilesMap, 3, 20);
      rankedFiles = ranked.map((r) => r.path);

      // Add any PR files not in the graph (new files have no import data yet)
      for (const f of prFiles) {
        if (!rankedFiles.includes(f.filename)) {
          rankedFiles.unshift(f.filename); // new files = highest priority
        }
      }
    } else {
      // Fallback: sort by lines changed descending (better than sequential)
      rankedFiles = [...prFiles]
        .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
        .map((f) => f.filename);
    }

    // ── 4. Build diff context within budget ───────────────────────────────
    const patchMap = new Map<string, PRFile>();
    for (const file of prFiles) {
      patchMap.set(file.filename, file);
    }

    const includedFiles: string[] = [];
    const excludedFiles: string[] = [];
    let diffContext = "";

    for (const filePath of rankedFiles) {
      const file = patchMap.get(filePath);
      if (!file || !file.patch) {
        // Transitively-at-risk file with no patch — note it but skip
        if (!patchMap.has(filePath)) {
          // It's a file affected by the PR but not directly changed
        }
        continue;
      }

      const fileSection =
        `File: ${file.filename} (${file.status}, +${file.additions} -${file.deletions})\n` +
        `Patch:\n${file.patch}\n`;

      if (diffContext.length + fileSection.length <= MAX_DIFF_CHARS) {
        diffContext += fileSection + "\n---\n\n";
        includedFiles.push(filePath);
      } else {
        excludedFiles.push(filePath);
      }
    }

    // ── 5. Find transitive risk files (not in PR but at risk) ─────────────
    const transitiveRiskFiles: string[] = [];
    if (graphUsed) {
      const blastRadius = graph.getBlastRadius(
        Array.from(changedFilesMap.keys()),
        2
      );
      for (const [filePath, distance] of blastRadius) {
        if (distance > 0 && !patchMap.has(filePath)) {
          transitiveRiskFiles.push(filePath);
        }
      }
    }

    // ── 6. Append a context note so the AI knows what was excluded ─────────
    if (excludedFiles.length > 0 || transitiveRiskFiles.length > 0) {
      diffContext += `\n[Context: ${excludedFiles.length} additional changed files omitted due to size limit`;
      if (transitiveRiskFiles.length > 0) {
        diffContext += `. The following files import changed modules and may be at risk: ${transitiveRiskFiles.slice(0, 5).join(", ")}`;
      }
      diffContext += "]\n";
    }

    return {
      diffContext,
      includedFiles,
      excludedFiles,
      transitiveRiskFiles,
      graphUsed,
    };
  }
}
