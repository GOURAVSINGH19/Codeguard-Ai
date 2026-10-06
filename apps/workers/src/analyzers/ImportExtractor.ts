import path from "path";
import type { ImportResolver } from "@codeguard/review-engine";

/**
 * ImportExtractor
 *
 * Extracts import specifiers from source text with regex and resolves them to
 * repository file paths.
 *
 * With an `ImportResolver` (built from the repository snapshot) it resolves
 * relative imports, tsconfig path aliases (`@/lib/x`) and workspace packages
 * (`@codeguard/db`), and only returns files that exist. Without one it falls
 * back to the old best-effort guess for relative imports only.
 *
 * Trade-off: dynamic imports (require(variable), import(someVar)) are missed.
 * That's acceptable — we're building a risk heuristic, not a type checker.
 */
export class ImportExtractor {
  constructor(private readonly resolver?: ImportResolver) {}

  /**
   * @param content    File source code
   * @param filePath   The file's path relative to repo root
   */
  extractImports(content: string, filePath: string): string[] {
    const specs = this.extractSpecifiers(content);
    const resolved = new Set<string>();
    for (const spec of specs) {
      const hit = this.resolver ? this.resolver.resolve(filePath, spec) : this.guessRelative(filePath, spec);
      if (hit && hit !== filePath) resolved.add(hit);
    }
    return [...resolved];
  }

  /** Raw import specifiers, with Python relative imports converted to path form. */
  extractSpecifiers(content: string): string[] {
    const raw: string[] = [];

    // ── TypeScript / JavaScript ────────────────────────────────────────────
    //   import ... from "x" · import "x" · export ... from "x" · require("x") · import("x")
    const tsPatterns = [
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of tsPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) raw.push(match[1]);
    }

    // ── Python relative imports ────────────────────────────────────────────
    //   from .module import x   → ./module
    //   from ..pkg.mod import y → ../pkg/mod
    const pythonPattern = /^\s*from\s+(\.+)([\w.]*)\s+import/gm;
    let py;
    while ((py = pythonPattern.exec(content)) !== null) {
      const ups = py[1].length - 1;
      const prefix = ups === 0 ? "./" : "../".repeat(ups);
      raw.push(prefix + py[2].replace(/\./g, "/"));
    }
    return [...new Set(raw)];
  }

  /** Fallback when no repository snapshot is available. */
  private guessRelative(filePath: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null;
    const joined = path.posix.join(path.posix.dirname(filePath), spec);
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(joined)) return joined;
    return `${joined}.ts`;
  }
}
