/**
 * Resolve an import specifier to a real file in the repository.
 *
 * Handles relative paths, tsconfig `paths` aliases (`@/lib/x`) and workspace
 * packages (`@codeguard/db`, `@codeguard/db/schema`), and only returns paths
 * that exist in the snapshot — no more guessing `.ts`.
 */
export interface ImportResolverOptions {
  /** Every file path in the repository snapshot. */
  files: Iterable<string>;
  pathAliases?: Record<string, string[]>;
  workspacePackages?: Record<string, string>;
}

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "__init__.py", "mod.rs"];
const JS_EXT_SWAP: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

export class ImportResolver {
  private readonly files: Set<string>;
  private readonly aliases: Array<{ prefix: string; wildcard: boolean; targets: string[] }>;
  private readonly packages: Array<[string, string]>;

  constructor(opts: ImportResolverOptions) {
    this.files = new Set(opts.files);
    this.aliases = Object.entries(opts.pathAliases ?? {})
      .map(([alias, targets]) => ({ prefix: alias.replace(/\*$/, ""), wildcard: alias.endsWith("*"), targets }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    this.packages = Object.entries(opts.workspacePackages ?? {}).sort((a, b) => b[0].length - a[0].length);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Resolve `spec` imported from `fromFile`; null for external packages or unknown files. */
  resolve(fromFile: string, spec: string): string | null {
    if (spec.startsWith(".")) {
      return this.probe(normalize(`${dirname(fromFile)}/${spec}`));
    }
    // Python relative-from-root style imports ("app.models.user") are handled by the caller.

    for (const alias of this.aliases) {
      const matches = alias.wildcard ? spec.startsWith(alias.prefix) : spec === alias.prefix;
      if (!matches) continue;
      const rest = alias.wildcard ? spec.slice(alias.prefix.length) : "";
      // Several projects may define the same alias (e.g. "@/*"); prefer the one
      // whose base directory contains the importing file.
      const targets = [...alias.targets].sort((a, b) => sharedPrefix(b, fromFile) - sharedPrefix(a, fromFile));
      for (const target of targets) {
        const hit = this.probe(normalize(target.replace(/\*$/, "") + rest));
        if (hit) return hit;
      }
    }

    for (const [name, dir] of this.packages) {
      if (spec !== name && !spec.startsWith(`${name}/`)) continue;
      const sub = spec.slice(name.length).replace(/^\//, "");
      const candidates = sub ? [`${dir}/${sub}`, `${dir}/src/${sub}`] : [`${dir}/src/index`, `${dir}/index`, `${dir}/src`];
      for (const c of candidates) {
        const hit = this.probe(normalize(c));
        if (hit) return hit;
      }
    }
    return null;
  }

  private probe(base: string): string | null {
    if (this.files.has(base)) return base;
    const ext = base.match(/\.[a-z]+$/)?.[0];
    if (ext && JS_EXT_SWAP[ext]) {
      // ESM TypeScript imports "./x.js" for "./x.ts".
      for (const swap of JS_EXT_SWAP[ext]) {
        const candidate = base.slice(0, -ext.length) + swap;
        if (this.files.has(candidate)) return candidate;
      }
    }
    for (const e of EXTENSIONS) if (this.files.has(base + e)) return base + e;
    for (const idx of INDEX_FILES) if (this.files.has(`${base}/${idx}`)) return `${base}/${idx}`;
    return null;
  }
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
