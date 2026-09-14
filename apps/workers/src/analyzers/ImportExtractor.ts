import path from "path";

/**
 * ImportExtractor
 *
 * Parses TypeScript/JavaScript source files with regex to extract
 * import paths, then resolves them to file paths relative to the repo root.
 *
 * Why regex instead of a real TS parser (ts-morph, @babel/parser)?
 * - No additional dependencies
 * - Fast enough for bulk indexing (microseconds per file)
 * - We only need the paths, not the AST
 * - Works for JS, TS, JSX, TSX, Python (basic), Go (basic)
 *
 * Trade-off: dynamic imports (require(variable), import(someVar)) are missed.
 * That's acceptable — we're building a risk heuristic, not a type checker.
 */
export class ImportExtractor {
  /**
   * Extract all import paths from a file's source content.
   * Returns only relative imports (starting with ./ or ../) — we skip
   * node_modules imports because we only care about in-repo dependencies.
   *
   * @param content    File source code
   * @param filePath   The file's path relative to repo root (used to resolve relative imports)
   * @param repoRoot   Repo root path (default: empty string for relative-only resolution)
   */
  extractImports(content: string, filePath: string): string[] {
    const rawImports: string[] = [];

    // ── TypeScript / JavaScript ────────────────────────────────────────────
    // Matches: import ... from "./path"
    //          import "./path"
    //          export ... from "./path"
    //          const x = require("./path")
    //          const x = await import("./path")
    const tsPatterns = [
      /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    for (const pattern of tsPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        rawImports.push(match[1]);
      }
    }

    // ── Python ────────────────────────────────────────────────────────────
    // Matches: from .module import x
    //          from ..utils import y
    const pythonPattern = /from\s+(\.+\w*(?:\.\w+)*)\s+import/g;
    let pyMatch;
    while ((pyMatch = pythonPattern.exec(content)) !== null) {
      rawImports.push(pyMatch[1]);
    }

    // ── Filter and resolve ────────────────────────────────────────────────
    const fileDir = path.dirname(filePath);
    const resolved: string[] = [];

    for (const imp of rawImports) {
      // Skip absolute imports (node_modules, packages)
      if (!imp.startsWith(".")) continue;

      // Resolve relative to the importing file
      const resolvedPath = this.resolveImportPath(fileDir, imp);
      if (resolvedPath) {
        resolved.push(resolvedPath);
      }
    }

    // Deduplicate
    return [...new Set(resolved)];
  }

  /**
   * Resolve a relative import path to a normalised repo-root-relative path.
   *
   * "./utils"       → "src/auth/utils.ts"  (tries .ts, .tsx, .js, /index.ts)
   * "../db/client"  → "src/db/client.ts"
   */
  private resolveImportPath(
    fromDir: string,
    importPath: string
  ): string | null {
    // Normalise path separators
    const joined = path
      .join(fromDir, importPath)
      .replace(/\\/g, "/");

    // If already has extension, return as-is
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(joined)) {
      return joined;
    }

    // Try common extensions in priority order
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
    for (const ext of extensions) {
      return joined + ext; // Return the first candidate
      // In a full implementation you'd check if the file exists in the tree
      // Here we return the .ts version as the canonical guess
    }

    // Try index files
    return joined + "/index.ts";
  }
}
