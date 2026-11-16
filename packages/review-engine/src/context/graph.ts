/**
 * Blast radius: "if these files change, what else could break?"
 *
 * Edges A → B mean "A imports B". Reverse them ("B is imported by A") and walk
 * outwards from the changed files breadth-first: distance 1 = direct importers,
 * distance 2 = their importers, and so on.
 */
export interface GraphFile {
  path: string;
  imports: string[];
}

export interface AffectedFile {
  path: string;
  distance: number;
  /** The changed file this one (transitively) depends on. */
  via: string;
}

export function reverseEdges(files: GraphFile[]): Map<string, string[]> {
  const importedBy = new Map<string, string[]>();
  for (const f of files) {
    for (const dep of f.imports) {
      const list = importedBy.get(dep);
      if (list) list.push(f.path);
      else importedBy.set(dep, [f.path]);
    }
  }
  return importedBy;
}

export function blastRadius(changed: string[], files: GraphFile[], maxDepth = 3): AffectedFile[] {
  const importedBy = reverseEdges(files);
  const seen = new Map<string, { distance: number; via: string }>(changed.map((p) => [p, { distance: 0, via: p }]));
  const queue = [...changed];

  while (queue.length) {
    const cur = queue.shift()!;
    const { distance, via } = seen.get(cur)!;
    if (distance >= maxDepth) continue;
    for (const parent of importedBy.get(cur) ?? []) {
      if (!seen.has(parent)) {
        seen.set(parent, { distance: distance + 1, via });
        queue.push(parent);
      }
    }
  }

  return [...seen]
    .filter(([, v]) => v.distance > 0)
    .map(([path, v]) => ({ path, ...v }))
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path));
}

/** How many files import this one directly? (A "hub" file changing is riskier.) */
export function fanIn(path: string, files: GraphFile[]): number {
  return files.filter((f) => f.imports.includes(path)).length;
}
