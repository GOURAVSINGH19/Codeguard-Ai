import type { PRFileInput } from "../diff";
import { addedLines } from "../diff";
import { classifyFile } from "./change";
import { makeFinding } from "./types";
import type { Finding } from "./types";

/**
 * Code context: the code the diff touches but does not show.
 *
 *  - Definitions: where the types and functions used on added lines are
 *    declared (from the files the changed code imports).
 *  - Call sites: where functions the PR changes are called (from the files
 *    that import the changed code), so the model sees HOW they are used.
 *  - Breaking changes: a function whose required parameters changed, or that
 *    was removed, while a caller outside the PR still uses the old shape.
 *
 * Text-only and language-light on purpose (TS/JS, Python, Go, Rust, Java-ish
 * declarations): the source files come from the caller, nothing is fetched.
 */

export interface SourceFile {
  path: string;
  text: string;
}

export interface Definition {
  name: string;
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface CallSite {
  name: string;
  file: string;
  line: number;
  /** Arguments passed, when the call fits on one line and has no spread. */
  argCount: number | null;
  /** The call with two lines either side, gutter-numbered. */
  snippet: string;
  /** True when the calling file is part of the PR (it may already be updated). */
  inPR: boolean;
}

export interface SignatureChange {
  name: string;
  file: string;
  /** New-file line of the new declaration (null when the function was removed). */
  line: number | null;
  before: string;
  after: string | null;
  requiredBefore: number;
  requiredAfter: number | null;
  /** Total parameters after the change; null = rest parameter (accepts any count). */
  maxAfter: number | null;
}

export interface CodeContext {
  definitions: Definition[];
  callSites: CallSite[];
  signatureChanges: SignatureChange[];
}

const MAX_DEFINITION_LINES = 30;
const MAX_DEFINITION_CHARS = 1_500;

// ─── Patch reading ───────────────────────────────────────────────────────────

/** Removed lines of a patch (old-side text only; line numbers are not needed). */
export function removedLines(patch: string | null | undefined): string[] {
  if (!patch) return [];
  return patch
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => l.slice(1));
}

/** The enclosing function git prints after a hunk header: `@@ -1,2 +1,2 @@ export function foo(`. */
function hunkContextNames(patch: string | null | undefined): string[] {
  if (!patch) return [];
  const names: string[] = [];
  for (const line of patch.split("\n")) {
    const m = /^@@ [^@]+ @@ (.*)$/.exec(line);
    if (!m) continue;
    const decl = parseDeclaration(m[1]);
    if (decl) names.push(decl.name);
  }
  return names;
}

// ─── Declarations ────────────────────────────────────────────────────────────

const KEYWORDS = new Set(
  (
    "abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends " +
    "false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object " +
    "of package private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique " +
    "unknown var void while with yield def elif lambda pass raise self cls None True False func struct impl pub mut fn match loop mod use crate trait " +
    "where println print len range nil chan defer go map select fallthrough goto"
  ).split(" ")
);

/** Globals that are never worth looking up. */
const BUILTINS = new Set(
  (
    "console Math JSON Promise Object Array String Number Boolean Error TypeError RangeError Date RegExp Map Set WeakMap WeakSet Symbol BigInt " +
    "process Buffer setTimeout clearTimeout setInterval clearInterval fetch Response Request URL URLSearchParams Headers window document globalThis " +
    "parseInt parseFloat isNaN encodeURIComponent decodeURIComponent structuredClone Record Partial Required Readonly Pick Omit ReturnType Awaited " +
    "Exclude Extract NonNullable Parameters React useState useEffect useMemo useCallback useRef describe expect test vi beforeEach afterEach"
  ).split(" ")
);

interface ParsedDeclaration {
  name: string;
  kind: "function" | "class" | "type" | "variable";
  /** Parameter list text between the parentheses, when it is on this line. */
  params: string | null;
}

const DECLARATION_PATTERNS: Array<{ re: RegExp; kind: ParsedDeclaration["kind"]; callable: boolean }> = [
  // function foo(…) · export default async function foo(…)
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/, kind: "function", callable: true },
  // const foo = (…) => · export const foo = async (…) =>  · const foo = function (…)
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\s*)?(?:<[^>]*>)?\s*\(/, kind: "function", callable: true },
  // def foo(…)  (Python)
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: "function", callable: true },
  // func foo(…) · func (r *T) foo(…)  (Go)
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/, kind: "function", callable: true },
  // fn foo(…)  (Rust)
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/, kind: "function", callable: true },
  // class / interface / enum / struct / trait
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub\s+)?(?:class|interface|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/, kind: "class", callable: false },
  // type Foo = … · type Foo struct (Go)
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b\s*(?:<[^>]*>)?\s*(?:=|struct|interface)/, kind: "type", callable: false },
  // const FOO = … (non-function values)
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, kind: "variable", callable: false },
];

/** Recognise a declaration line and pull out its name and (single-line) parameter list. */
export function parseDeclaration(line: string): ParsedDeclaration | null {
  for (const { re, kind, callable } of DECLARATION_PATTERNS) {
    const m = re.exec(line);
    if (!m) continue;
    let params: string | null = null;
    if (callable) {
      const open = m.index + m[0].length - 1;
      const close = matchingParen(line, open);
      params = close === -1 ? null : line.slice(open + 1, close);
    }
    return { name: m[1], kind, params };
  }
  return null;
}

/** Index of the parenthesis closing the one at `open`, or -1 if not on this line. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split on commas that are not nested inside brackets, braces, parens, generics or strings. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      current += c;
      if (c === "\\") current += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c) && !(c === ">" && text[i - 1] === "=")) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Required and maximum parameter counts. `max` is null with a rest parameter. */
export function parameterArity(params: string): { required: number; max: number | null } {
  const list = splitTopLevel(params).filter((p, i) => !(i === 0 && /^(self|cls|&?(?:mut\s+)?self)\b/.test(p)));
  let required = 0;
  let rest = false;
  for (const p of list) {
    if (p.startsWith("...") || p.startsWith("*")) {
      rest = true;
      continue;
    }
    // `= value` is a default; `=>` inside a callback type is not.
    const optional = /^[\w$]+\s*\?/.test(p) || /(^|[^=!<>])=(?![=>])/.test(p);
    if (!optional) required++;
  }
  return { required, max: rest ? null : list.length };
}

/** Arguments in the call whose `(` is at `open` (null when it spans lines or spreads). */
function callArgCount(line: string, open: number): number | null {
  const close = matchingParen(line, open);
  if (close === -1) return null;
  const inner = line.slice(open + 1, close);
  if (inner.trim() === "") return 0;
  const args = splitTopLevel(inner);
  return args.some((a) => a.startsWith("...") || a.startsWith("*")) ? null : args.length;
}

// ─── Definitions ─────────────────────────────────────────────────────────────

/** Identifiers used on added lines of source files, most used first. */
export function identifiersUsed(files: PRFileInput[], limit = 40): string[] {
  const counts = new Map<string, number>();
  const declaredHere = new Set<string>();
  for (const f of files) {
    if (classifyFile(f.filename) !== "source") continue;
    for (const { text } of addedLines(f.patch)) {
      const decl = parseDeclaration(text);
      if (decl) declaredHere.add(decl.name);
      // Drop quoted strings and comments: they are not code that refers to anything.
      // Template literals stay, since `${call(x)}` inside them is code.
      const comment = /\.(py|sh|rb)$/.test(f.filename) ? /#.*$/ : /\/\/.*$/;
      const code = text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(comment, "");
      for (const m of code.matchAll(/\b([A-Za-z_$][\w$]{2,})\b/g)) {
        const id = m[1];
        if (KEYWORDS.has(id) || BUILTINS.has(id)) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .filter(([id]) => !declaredHere.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/** The declaration block starting at `start` (0-based): braces balanced, or Python-style indentation. */
function declarationBlock(lines: string[], start: number): { end: number; text: string } {
  const first = lines[start];
  const indent = first.length - first.trimStart().length;
  const usesBraces = /[{(]\s*$/.test(first) || first.includes("{");
  let end = start;
  if (usesBraces) {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length && i < start + MAX_DEFINITION_LINES; i++) {
      for (const c of lines[i]) {
        if (c === "{" || c === "(" || c === "[") {
          depth++;
          opened = true;
        } else if (c === "}" || c === ")" || c === "]") depth--;
      }
      end = i;
      if (opened && depth <= 0) break;
    }
  } else if (/:\s*(#.*)?$/.test(first)) {
    // Python: the body is everything indented deeper than the declaration.
    for (let i = start + 1; i < lines.length && i < start + MAX_DEFINITION_LINES; i++) {
      const l = lines[i];
      if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
      end = i;
    }
    while (end > start && lines[end].trim() === "") end--;
  }
  let text = lines
    .slice(start, end + 1)
    .map((l, i) => `${String(start + i + 1).padStart(4)}  ${l}`)
    .join("\n");
  if (text.length > MAX_DEFINITION_CHARS) text = `${text.slice(0, MAX_DEFINITION_CHARS)}\n      …`;
  return { end, text };
}

/** Where each name is declared in `sources` (first match per name). */
export function findDefinitions(names: string[], sources: SourceFile[], limit = 8): Definition[] {
  const wanted = new Set(names);
  const found = new Map<string, Definition>();
  for (const src of sources) {
    const lines = src.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const decl = parseDeclaration(lines[i]);
      if (!decl || !wanted.has(decl.name) || found.has(decl.name)) continue;
      // The doc comment above often says what matters ("amount in dollars, not cents").
      let start = i;
      while (start > 0 && i - start < 8 && /^\s*(\/\*\*|\*|\/\/|#|@|""")/.test(lines[start - 1])) start--;
      const block = declarationBlock(lines, i);
      const doc = lines
        .slice(start, i)
        .map((l, k) => `${String(start + k + 1).padStart(4)}  ${l}`)
        .join("\n");
      found.set(decl.name, { name: decl.name, file: src.path, startLine: start + 1, endLine: block.end + 1, text: doc ? `${doc}\n${block.text}` : block.text });
    }
  }
  // Keep the caller's order (most used first).
  return names.filter((n) => found.has(n)).slice(0, limit).map((n) => found.get(n)!);
}

// ─── Changed functions and their call sites ─────────────────────────────────

/** Functions declared on changed lines, or enclosing a hunk (git's hunk-header context). */
export function changedFunctionNames(files: PRFileInput[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    if (classifyFile(f.filename) !== "source") continue;
    for (const { text } of addedLines(f.patch)) {
      const d = parseDeclaration(text);
      if (d && (d.kind === "function" || d.kind === "class")) names.add(d.name);
    }
    for (const text of removedLines(f.patch)) {
      const d = parseDeclaration(text);
      if (d && (d.kind === "function" || d.kind === "class")) names.add(d.name);
    }
    for (const n of hunkContextNames(f.patch)) names.add(n);
  }
  return [...names].filter((n) => n.length >= 3 && !KEYWORDS.has(n));
}

/** Calls of `names` in `sources`, skipping declarations and import lines. */
export function findCallSites(names: string[], sources: SourceFile[], prFiles: Set<string>, opts: { perName?: number; total?: number } = {}): CallSite[] {
  const perName = opts.perName ?? 4;
  const total = opts.total ?? 12;
  const sites: CallSite[] = [];
  // Callers outside the PR first: those are the ones the PR did not update.
  const ordered = [...sources].sort((a, b) => Number(prFiles.has(a.path)) - Number(prFiles.has(b.path)));
  for (const name of names) {
    const call = new RegExp(`(?:^|[^\\w$.])(?:new\\s+)?(?:[\\w$]+\\.)*${name.replace(/\$/g, "\\$")}\\s*(\\()`, "g");
    let count = 0;
    for (const src of ordered) {
      const lines = src.text.split("\n");
      for (let i = 0; i < lines.length && count < perName; i++) {
        const line = lines[i];
        if (/^\s*(import|from|export\s+\{|export\s+\*)\b/.test(line) || /require\s*\(/.test(line)) continue;
        if (parseDeclaration(line)?.name === name) continue;
        call.lastIndex = 0;
        const m = call.exec(line);
        if (!m) continue;
        const open = m.index + m[0].length - 1;
        const from = Math.max(0, i - 2);
        const snippet = lines
          .slice(from, Math.min(lines.length, i + 3))
          .map((l, k) => `${String(from + k + 1).padStart(4)}${from + k === i ? " >" : "  "} ${l}`)
          .join("\n");
        sites.push({ name, file: src.path, line: i + 1, argCount: callArgCount(line, open), snippet, inPR: prFiles.has(src.path) });
        count++;
      }
      if (count >= perName) break;
    }
  }
  return sites.sort((a, b) => Number(a.inPR) - Number(b.inPR)).slice(0, total);
}

// ─── Signature changes ───────────────────────────────────────────────────────

/** Functions whose required parameters changed, or that were removed, in this PR. */
export function detectSignatureChanges(files: PRFileInput[]): SignatureChange[] {
  const addedAnywhere = new Set<string>();
  const perFile: Array<{ file: string; removed: Map<string, string>; added: Map<string, { line: number; text: string }> }> = [];
  for (const f of files) {
    if (classifyFile(f.filename) !== "source") continue;
    const removed = new Map<string, string>();
    const added = new Map<string, { line: number; text: string }>();
    for (const text of removedLines(f.patch)) {
      const d = parseDeclaration(text);
      if (d?.kind === "function" && d.params !== null) removed.set(d.name, text.trim());
    }
    for (const a of addedLines(f.patch)) {
      const d = parseDeclaration(a.text);
      if (d?.kind === "function") {
        added.set(d.name, { line: a.line, text: a.text.trim() });
        addedAnywhere.add(d.name);
      }
    }
    perFile.push({ file: f.filename, removed, added });
  }

  const changes: SignatureChange[] = [];
  for (const { file, removed, added } of perFile) {
    for (const [name, beforeText] of removed) {
      const before = parameterArity(parseDeclaration(beforeText)!.params!);
      const now = added.get(name);
      if (!now) {
        // Removed here and not re-declared anywhere in the PR (a move to another file is fine).
        if (!addedAnywhere.has(name)) {
          changes.push({ name, file, line: null, before: beforeText, after: null, requiredBefore: before.required, requiredAfter: null, maxAfter: null });
        }
        continue;
      }
      const params = parseDeclaration(now.text)!.params;
      if (params === null) continue; // multi-line signature: can't compare safely
      const after = parameterArity(params);
      if (after.required === before.required && after.max === before.max) continue;
      changes.push({ name, file, line: now.line, before: beforeText, after: now.text, requiredBefore: before.required, requiredAfter: after.required, maxAfter: after.max });
    }
  }
  return changes;
}

/**
 * Deterministic findings: callers outside the PR that still use the old
 * signature (too few or too many arguments), or call a removed function.
 * Confidence stays below "trusted" so the verifier checks them against the code.
 */
export function breakingChangeFindings(changes: SignatureChange[], sites: CallSite[]): Finding[] {
  const findings: Finding[] = [];
  for (const ch of changes) {
    const outside = sites.filter((s) => s.name === ch.name && !s.inPR);
    if (ch.after === null) {
      if (outside.length === 0) continue;
      findings.push(
        makeFinding({
          source: "blast_radius",
          severity: "high",
          category: "bug",
          file: ch.file,
          line: null,
          ruleId: "breaking-change/removed",
          message: `\`${ch.name}\` was removed, but it is still called outside this PR: ${outside.map((s) => `${s.file}:${s.line}`).join(", ")}.`,
          suggestion: `Update those callers in this PR, or keep \`${ch.name}\` as a deprecated wrapper.`,
          confidence: 0.8,
          deterministic: true,
        })
      );
      continue;
    }
    const broken = outside.filter(
      (s) => s.argCount !== null && (s.argCount < (ch.requiredAfter ?? 0) || (ch.maxAfter !== null && s.argCount > ch.maxAfter))
    );
    if (broken.length === 0) continue;
    const expected = ch.maxAfter === ch.requiredAfter ? `${ch.requiredAfter}` : `${ch.requiredAfter}–${ch.maxAfter ?? "∞"}`;
    findings.push(
      makeFinding({
        source: "blast_radius",
        severity: "high",
        category: "bug",
        file: ch.file,
        line: ch.line,
        ruleId: "breaking-change/arity",
        message: `\`${ch.name}\` now takes ${expected} argument(s), but callers outside this PR were not updated: ${broken
          .map((s) => `${s.file}:${s.line} passes ${s.argCount}`)
          .join(", ")}.`,
        suggestion: "Update the callers in this PR, or give the new parameter a default value.",
        confidence: 0.85,
        deterministic: true,
      })
    );
  }
  return findings;
}

// ─── Prompt text ─────────────────────────────────────────────────────────────

/** Prompt section for the reviewers and the verifier, within `budgetChars`. */
export function formatCodeContext(ctx: CodeContext, budgetChars = 6_000): string | undefined {
  const sections: string[] = [];
  let used = 0;
  const add = (text: string) => {
    if (used + text.length > budgetChars) return false;
    sections.push(text);
    used += text.length;
    return true;
  };

  if (ctx.signatureChanges.length > 0) {
    add(
      "## Signature changes in this PR\n" +
        ctx.signatureChanges
          .map((c) => `- ${c.file}: \`${c.before}\` → ${c.after ? `\`${c.after}\`` : "removed"}`)
          .join("\n")
    );
  }
  const outside = ctx.callSites.filter((s) => !s.inPR);
  const inside = ctx.callSites.filter((s) => s.inPR);
  if (outside.length > 0) {
    add("## Call sites of changed functions in files NOT changed by this PR (they still use the code as shown)");
    for (const s of outside) if (!add(`### ${s.file} (calls \`${s.name}\`, line ${s.line})\n\`\`\`\n${s.snippet}\n\`\`\``)) break;
  }
  if (inside.length > 0) {
    add("## Call sites inside this PR");
    for (const s of inside) if (!add(`### ${s.file} (calls \`${s.name}\`, line ${s.line})\n\`\`\`\n${s.snippet}\n\`\`\``)) break;
  }
  if (ctx.definitions.length > 0) {
    add("## Definitions used by the changed code");
    for (const d of ctx.definitions) if (!add(`### \`${d.name}\` — ${d.file} (lines ${d.startLine}–${d.endLine})\n\`\`\`\n${d.text}\n\`\`\``)) break;
  }
  // Only headings made it in: nothing worth sending.
  return sections.some((s) => s.includes("```") || s.startsWith("## Signature")) ? sections.join("\n\n") : undefined;
}
