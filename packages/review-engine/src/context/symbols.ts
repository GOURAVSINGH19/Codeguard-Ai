import ts from "typescript";
import { TS_LIKE } from "./chunker";

/**
 * "Callers of changed functions" (CodeRabbit idea).
 *
 * RAG finds code that LOOKS like the change. Callers usually don't look like
 * the function they call, but they are exactly what breaks when its behaviour
 * changes. So: find the symbols whose bodies contain changed lines, then find
 * where those symbols are used in the files that import them.
 */

/** Names of top-level functions/classes/consts (and class methods) that contain any of `lines`. */
export function changedSymbols(path: string, content: string, lines: Set<number>): string[] {
  if (!TS_LIKE.test(path) || lines.size === 0) return [];
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const touches = (node: ts.Node) => {
    const start = lineOf(node.getStart(sf));
    const end = lineOf(node.getEnd());
    for (const l of lines) if (l >= start && l <= end) return true;
    return false;
  };

  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (!touches(node)) return;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      names.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Very short or generic names produce noisy matches.
  return [...names].filter((n) => n.length >= 3 && !["get", "set", "run", "main", "default", "handler"].includes(n));
}

export interface CallerSnippet {
  symbol: string;
  path: string;
  line: number;
  snippet: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines in `files` that call/construct/reference one of `symbols`, with ±radius lines of context. */
export function findCallers(
  symbols: string[],
  files: Array<{ path: string; content: string }>,
  { radius = 5, max = 12 }: { radius?: number; max?: number } = {},
): CallerSnippet[] {
  if (!symbols.length) return [];
  const re = new RegExp(`\\b(new\\s+)?(${symbols.map(escape).join("|")})\\s*[(<.]`);
  const out: CallerSnippet[] = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const m = re.exec(lines[i]);
      if (!m || /^\s*(import|export\s+\{|\/\/|\*)/.test(lines[i])) continue;
      const from = Math.max(0, i - radius);
      out.push({
        symbol: m[2],
        path: f.path,
        line: i + 1,
        snippet: lines.slice(from, i + radius + 1).map((l, k) => `${String(from + k + 1).padStart(5)} | ${l}`).join("\n"),
      });
      i += radius; // don't return overlapping snippets from the same spot
    }
  }
  return out;
}
