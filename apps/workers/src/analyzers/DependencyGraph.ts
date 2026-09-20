/**
 * DependencyGraph
 *
 * Builds a directed graph of import relationships between files in a repository.
 *
 * Nodes  = file paths (e.g. "src/utils/auth.ts")
 * Edges  = import relationships
 *          A → B means "file A imports from file B"
 *          (A depends on B, so a change to B risks breaking A)
 *
 * The graph is used to find the blast radius of a PR:
 * given the set of directly changed files, BFS/DFS through
 * reverse edges (who imports the changed file?) to find
 * all transitively affected files.
 *
 * Example:
 *   PR changes: src/utils/token.ts
 *   Graph edges (reverse): token.ts ← auth.ts ← middleware.ts ← api/users.ts
 *   Blast radius: [token.ts, auth.ts, middleware.ts, api/users.ts]
 *
 * Why a graph and not a simple import list?
 * Because the risk is TRANSITIVE. A change to a leaf utility can break
 * every file that transitively depends on it — not just direct importers.
 */

export interface GraphNode {
  path: string;
  // files this node imports FROM (outgoing edges: "this file depends on these")
  imports: Set<string>;
  // files that import THIS node (incoming edges: "these files depend on this")
  importedBy: Set<string>;
}

export interface RankedFile {
  path: string;
  directlyChanged: boolean;
  // how many hops from a changed file (0 = changed, 1 = direct importer, etc.)
  distanceFromChange: number;
  // how many changed files transitively affect this file
  changeImpactScore: number;
  // total lines changed across all directly-changed files this depends on
  linesAtRisk: number;
}

export class DependencyGraph {
  // Map from file path → node
  private nodes = new Map<string, GraphNode>();

  // ─── Build phase ───────────────────────────────────────────────────────────

  /**
   * Add a file and its import list to the graph.
   * Call this for every file in the repository during indexing.
   *
   * @param filePath  e.g. "src/utils/auth.ts"
   * @param imports   resolved paths this file imports, e.g. ["src/utils/token.ts"]
   */
  addFile(filePath: string, imports: string[]): void {
    // Ensure this node exists
    if (!this.nodes.has(filePath)) {
      this.nodes.set(filePath, {
        path: filePath,
        imports: new Set(),
        importedBy: new Set(),
      });
    }

    const node = this.nodes.get(filePath)!;

    for (const importedPath of imports) {
      node.imports.add(importedPath);

      // Ensure the imported file has a node too
      if (!this.nodes.has(importedPath)) {
        this.nodes.set(importedPath, {
          path: importedPath,
          imports: new Set(),
          importedBy: new Set(),
        });
      }

      // Add reverse edge: importedPath is imported by filePath
      this.nodes.get(importedPath)!.importedBy.add(filePath);
    }
  }

  // ─── Query phase ───────────────────────────────────────────────────────────

  /**
   * BFS from the changed files through REVERSE edges (importedBy).
   * Returns all files that transitively depend on the changed files.
   *
   * This is the "blast radius" of the PR.
   *
   * @param changedFiles  Files directly modified in the PR
   * @param maxDepth      Max hops to traverse (default 3 — prevents crawling the whole graph)
   */
  getBlastRadius(
    changedFiles: string[],
    maxDepth = 3
  ): Map<string, number> {
    // Map of filePath → distance from a changed file
    const visited = new Map<string, number>();
    const queue: Array<{ path: string; depth: number }> = [];

    // Seed BFS with directly changed files at depth 0
    for (const file of changedFiles) {
      if (!visited.has(file)) {
        visited.set(file, 0);
        queue.push({ path: file, depth: 0 });
      }
    }

    // BFS through reverse edges
    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;

      if (depth >= maxDepth) continue;

      const node = this.nodes.get(path);
      if (!node) continue;

      for (const importer of node.importedBy) {
        if (!visited.has(importer)) {
          visited.set(importer, depth + 1);
          queue.push({ path: importer, depth: depth + 1 });
        }
      }
    }

    return visited;
  }

  /**
   * Given the PR's changed files and their patch sizes, rank ALL affected files
   * by risk priority for the AI review.
   *
   * Ranking formula:
   *   score = (linesChanged * 3)           ← direct changes are weighted highest
   *         + (transitiveImpact * 2)        ← files many others depend on
   *         + (1 / (distanceFromChange + 1)) ← closer to the change = higher risk
   *
   * @param changedFiles  Map of filePath → lines changed (additions + deletions)
   * @param maxDepth      BFS depth limit
   * @param maxFiles      Max files to return (for context window budget)
   */
  rankFilesForReview(
    changedFiles: Map<string, number>,
    maxDepth = 3,
    maxFiles = 15
  ): RankedFile[] {
    const blastRadius = this.getBlastRadius(
      Array.from(changedFiles.keys()),
      maxDepth
    );

    const ranked: RankedFile[] = [];

    for (const [path, distance] of blastRadius) {
      const directLines = changedFiles.get(path) ?? 0;
      const node = this.nodes.get(path);

      // How many changed files transitively reach this node
      // (counts how many changed files are in this node's transitive imports)
      const changeImpactScore = this.countChangedDependencies(
        path,
        changedFiles,
        maxDepth
      );

      // Risk score — higher = review first
      const riskScore =
        directLines * 3 +
        changeImpactScore * 2 +
        1 / (distance + 1);

      ranked.push({
        path,
        directlyChanged: distance === 0,
        distanceFromChange: distance,
        changeImpactScore,
        linesAtRisk: directLines,
      });
    }

    // Sort by risk: direct changes first, then by impact score, then by distance
    ranked.sort((a, b) => {
      if (a.directlyChanged !== b.directlyChanged) {
        return a.directlyChanged ? -1 : 1;
      }
      if (b.changeImpactScore !== a.changeImpactScore) {
        return b.changeImpactScore - a.changeImpactScore;
      }
      return a.distanceFromChange - b.distanceFromChange;
    });

    return ranked.slice(0, maxFiles);
  }

  /**
   * Returns the number of changed files that this file transitively imports.
   * Higher = this file is more likely to break because of the PR.
   */
  private countChangedDependencies(
    filePath: string,
    changedFiles: Map<string, number>,
    maxDepth: number
  ): number {
    const visited = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [
      { path: filePath, depth: 0 },
    ];
    let count = 0;

    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;
      if (visited.has(path) || depth > maxDepth) continue;
      visited.add(path);

      if (changedFiles.has(path) && path !== filePath) count++;

      const node = this.nodes.get(path);
      if (node) {
        for (const dep of node.imports) {
          if (!visited.has(dep)) {
            queue.push({ path: dep, depth: depth + 1 });
          }
        }
      }
    }

    return count;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  /** Total number of files in the graph */
  get size(): number {
    return this.nodes.size;
  }

  /** Get all direct importers of a file (one hop only) */
  getDirectImporters(filePath: string): string[] {
    return Array.from(this.nodes.get(filePath)?.importedBy ?? []);
  }

  /** Get all files this file directly imports */
  getDirectDependencies(filePath: string): string[] {
    return Array.from(this.nodes.get(filePath)?.imports ?? []);
  }
}
