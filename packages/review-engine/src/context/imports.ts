import path from "node:path/posix";
import ts from "typescript";

/**
 * Which repo files does this file import? (The edges of the import graph.)
 *
 * ts.preProcessFile is TypeScript's cheapest import scanner: no type checking,
 * no full AST. It finds `import … from`, `export … from`, `require()` and `import()`.
 */

/** Alias prefix → repo folder, e.g. { "@/": "src/" } from tsconfig "paths": { "@/*": ["./src/*"] }. */
export type Aliases = Record<string, string>;

export const DEFAULT_ALIASES: Aliases = { "@/": "src/", "~/": "src/" };

/** Read `compilerOptions.paths` from a tsconfig.json (comments allowed) into simple prefix aliases. */
export function aliasesFromTsconfig(tsconfigText: string | null, tsconfigDir = ""): Aliases {
  if (!tsconfigText) return DEFAULT_ALIASES;
  const { config } = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText);
  const opts = (config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
  const base = path.join(tsconfigDir, opts.baseUrl ?? ".");
  const out: Aliases = {};
  for (const [key, targets] of Object.entries(opts.paths ?? {})) {
    if (!key.endsWith("/*") || !targets?.[0]?.endsWith("/*")) continue;
    const target = path.normalize(path.join(base, targets[0].slice(0, -1)));
    out[key.slice(0, -1)] = target === "." ? "" : target.replace(/^\.\//, "").replace(/\/?$/, "/");
  }
  return Object.keys(out).length ? out : DEFAULT_ALIASES;
}

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const INDEXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/** Resolve one import specifier to a repo path, or null (a package like "react", or not in the repo). */
export function resolveImport(fromPath: string, spec: string, allPaths: Set<string>, aliases: Aliases = DEFAULT_ALIASES): string | null {
  let base: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.normalize(path.join(path.dirname(fromPath), spec));
  } else {
    const prefix = Object.keys(aliases).find((p) => spec.startsWith(p));
    if (prefix !== undefined) base = path.normalize(aliases[prefix] + spec.slice(prefix.length));
  }
  if (!base || base.startsWith("..")) return null;

  // ESM-style TS imports say "./x.js" but the file is "./x.ts".
  const stems = /\.(c|m)?js$/.test(base) ? [base, base.replace(/\.(c|m)?js$/, ".$1ts"), base.replace(/\.(c|m)?js$/, ".tsx")] : [base];
  for (const stem of stems) {
    for (const ext of EXTENSIONS) if (allPaths.has(stem + ext)) return stem + ext;
    for (const idx of INDEXES) if (allPaths.has(stem + idx)) return stem + idx;
  }
  return null;
}

export function importsOf(filePath: string, content: string, allPaths: Set<string>, aliases?: Aliases): string[] {
  const { importedFiles } = ts.preProcessFile(content, true, true);
  const out = new Set<string>();
  for (const f of importedFiles) {
    const resolved = resolveImport(filePath, f.fileName, allPaths, aliases);
    if (resolved && resolved !== filePath) out.add(resolved);
  }
  return [...out];
}
