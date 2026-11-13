import path from "node:path";

/**
 * Run ESLint on the HEAD version of changed JS/TS files (CodeRabbit idea:
 * deterministic tools first, the model adds judgement on top).
 *
 * Only messages on ADDED lines are kept: we review the change, not old code.
 * ESLint is loaded lazily so code that never lints doesn't pay for it.
 */
export interface LintInput {
  path: string;
  content: string;
  addedLines: Set<number>;
}

export interface LintFinding {
  file: string;
  line: number;
  ruleId: string;
  message: string;
  severity: "error" | "warning";
}

export const LINTABLE = /\.(c|m)?(j|t)sx?$/;

/** Rules that are mostly noise without the repo's real config/types. */
const NOISY_RULES: Record<string, "off"> = {
  "no-undef": "off", // globals depend on the environment; TypeScript handles this
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-require-imports": "off",
  "@typescript-eslint/no-empty-object-type": "off",
};

export async function lintFiles(files: LintInput[]): Promise<LintFinding[]> {
  const targets = files.filter((f) => LINTABLE.test(f.path) && f.addedLines.size > 0);
  if (targets.length === 0) return [];

  const [{ ESLint }, { default: js }, { default: tseslint }] = await Promise.all([
    import("eslint"),
    import("@eslint/js"),
    import("typescript-eslint"),
  ]);

  const cwd = path.resolve("/codeguard-lint"); // virtual root: files are linted from memory, never written to disk
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true, // ignore any eslint config on this machine
    overrideConfig: [
      { files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"] },
      js.configs.recommended,
      ...tseslint.configs.recommended,
      {
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        rules: NOISY_RULES,
      },
    ] as never,
  });

  const out: LintFinding[] = [];
  for (const f of targets) {
    try {
      const [result] = await eslint.lintText(f.content, { filePath: path.join(cwd, f.path) });
      for (const m of result?.messages ?? []) {
        if (!m.ruleId || !f.addedLines.has(m.line)) continue; // parse errors / old lines
        out.push({ file: f.path, line: m.line, ruleId: m.ruleId, message: m.message, severity: m.severity === 2 ? "error" : "warning" });
      }
    } catch (err) {
      console.warn(`[lint] ${f.path} skipped:`, (err as Error).message);
    }
  }
  return out;
}
