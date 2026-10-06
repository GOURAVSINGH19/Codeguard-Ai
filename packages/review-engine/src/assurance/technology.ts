/**
 * detect_technology: languages, frameworks and project layout from the
 * repository tree and a few manifest files. Also extracts what the import
 * resolver needs: tsconfig path aliases and workspace package locations.
 */

export interface TechnologyProfile {
  languages: Array<{ name: string; files: number }>;
  frameworks: string[];
  testFrameworks: string[];
  packageManagers: string[];
  monorepo: boolean;
  /** tsconfig `paths`, e.g. { "@/*": ["apps/web/src/*"] } — already rebased to the repo root. */
  pathAliases: Record<string, string[]>;
  /** Workspace package name → directory, e.g. { "@codeguard/db": "packages/db" }. */
  workspacePackages: Record<string, string>;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", cs: "C#",
  rb: "Ruby", php: "PHP", swift: "Swift", scala: "Scala", c: "C", h: "C", cpp: "C++", hpp: "C++",
  vue: "Vue", svelte: "Svelte", sql: "SQL",
};

const NODE_FRAMEWORKS: Record<string, string> = {
  next: "Next.js", react: "React", vue: "Vue", svelte: "Svelte", "@angular/core": "Angular",
  express: "Express", fastify: "Fastify", "@nestjs/core": "NestJS", hono: "Hono", koa: "Koa",
  "drizzle-orm": "Drizzle ORM", "@prisma/client": "Prisma", typeorm: "TypeORM", mongoose: "Mongoose", sequelize: "Sequelize",
  kafkajs: "Kafka", "@clerk/nextjs": "Clerk", "next-auth": "NextAuth", zod: "Zod", graphql: "GraphQL", "socket.io": "Socket.IO",
  openai: "OpenAI SDK", "@anthropic-ai/sdk": "Anthropic SDK", stripe: "Stripe",
};
const NODE_TEST: Record<string, string> = { vitest: "Vitest", jest: "Jest", mocha: "Mocha", "@playwright/test": "Playwright", cypress: "Cypress" };
const PY_FRAMEWORKS: Record<string, string> = { django: "Django", flask: "Flask", fastapi: "FastAPI", sqlalchemy: "SQLAlchemy", celery: "Celery", pydantic: "Pydantic" };

export interface ManifestFiles {
  /** path → file content, for package.json / tsconfig*.json / pnpm-workspace.yaml / pyproject.toml / requirements*.txt / go.mod / Cargo.toml / pom.xml */
  [path: string]: string;
}

/** Paths of manifest files worth fetching from a tree listing (bounded). */
export function manifestPathsToFetch(paths: string[], limit = 40): string[] {
  const wanted = paths.filter((p) => {
    if (/(^|\/)node_modules\//.test(p)) return false;
    const base = p.split("/").pop()!;
    const depth = p.split("/").length;
    if (base === "package.json") return depth <= 3;
    if (/^tsconfig(\.[\w-]+)?\.json$/.test(base)) return depth <= 3;
    return depth <= 2 && /^(pnpm-workspace\.yaml|pyproject\.toml|requirements(-\w+)?\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile)$/.test(base);
  });
  return wanted.sort((a, b) => a.split("/").length - b.split("/").length).slice(0, limit);
}

/** Lenient JSON (tsconfig allows comments and trailing commas). */
function parseJsonc(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const stripped = text
        .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
        .replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function joinPath(base: string, rel: string): string {
  const parts = (base ? `${base}/${rel}` : rel).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

export function detectTechnology(paths: string[], manifests: ManifestFiles): TechnologyProfile {
  const langCount = new Map<string, number>();
  for (const p of paths) {
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    const lang = LANGUAGE_BY_EXT[ext];
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }
  const languages = [...langCount].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files);

  const frameworks = new Set<string>();
  const testFrameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const workspacePackages: Record<string, string> = {};
  const pathAliases: Record<string, string[]> = {};
  let packageJsonCount = 0;

  for (const [path, content] of Object.entries(manifests)) {
    const base = path.split("/").pop()!;
    if (base === "package.json") {
      packageJsonCount++;
      const pkg = parseJsonc(content);
      if (!pkg) continue;
      if (pkg.name && dirOf(path)) workspacePackages[pkg.name] = dirOf(path);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      for (const dep of Object.keys(deps)) {
        if (NODE_FRAMEWORKS[dep]) frameworks.add(NODE_FRAMEWORKS[dep]);
        if (NODE_TEST[dep]) testFrameworks.add(NODE_TEST[dep]);
      }
      if (typeof pkg.packageManager === "string") packageManagers.add(pkg.packageManager.split("@")[0]);
    } else if (/^tsconfig/.test(base)) {
      const ts = parseJsonc(content);
      const opts = ts?.compilerOptions;
      if (!opts?.paths) continue;
      const baseUrl = joinPath(dirOf(path), opts.baseUrl ?? ".");
      for (const [alias, targets] of Object.entries(opts.paths as Record<string, string[]>)) {
        if (!Array.isArray(targets)) continue;
        // Aliases are per-project; keep every project's mapping (prefixed checks happen at resolve time).
        const rebased = targets.map((t) => joinPath(baseUrl, t));
        pathAliases[alias] = [...new Set([...(pathAliases[alias] ?? []), ...rebased])];
      }
    } else if (base === "pnpm-workspace.yaml") {
      packageManagers.add("pnpm");
    } else if (/^(pyproject\.toml|requirements)/.test(base)) {
      for (const [dep, name] of Object.entries(PY_FRAMEWORKS)) if (new RegExp(`\\b${dep}\\b`, "i").test(content)) frameworks.add(name);
      if (/\bpytest\b/i.test(content)) testFrameworks.add("pytest");
      packageManagers.add(base === "pyproject.toml" && /\[tool\.poetry\]/.test(content) ? "poetry" : "pip");
    } else if (base === "go.mod") {
      packageManagers.add("go modules");
      if (/gin-gonic\/gin/.test(content)) frameworks.add("Gin");
      if (/labstack\/echo/.test(content)) frameworks.add("Echo");
    } else if (base === "Cargo.toml") {
      packageManagers.add("cargo");
      if (/\b(axum|actix-web|rocket)\b/.test(content)) frameworks.add(content.match(/\b(axum|actix-web|rocket)\b/)![1]);
    } else if (/^(pom\.xml|build\.gradle)/.test(base)) {
      if (/spring-boot/.test(content)) frameworks.add("Spring Boot");
      packageManagers.add(base.startsWith("pom") ? "maven" : "gradle");
    }
  }
  if (paths.includes("pnpm-lock.yaml")) packageManagers.add("pnpm");
  if (paths.includes("yarn.lock")) packageManagers.add("yarn");
  if (paths.includes("package-lock.json")) packageManagers.add("npm");

  return {
    languages,
    frameworks: [...frameworks].sort(),
    testFrameworks: [...testFrameworks].sort(),
    packageManagers: [...packageManagers].sort(),
    monorepo: packageJsonCount > 1 || paths.includes("pnpm-workspace.yaml") || paths.includes("lerna.json") || paths.includes("turbo.json"),
    pathAliases,
    workspacePackages,
  };
}
