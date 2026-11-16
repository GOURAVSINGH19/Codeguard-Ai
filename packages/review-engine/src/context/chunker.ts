import ts from "typescript";

/**
 * Cut a file into chunks for embedding.
 *
 * JS/TS: one chunk per top-level declaration (function, class, exported const…),
 * using TypeScript's own parser, so chunks follow real code boundaries.
 * Everything else: fixed line windows with overlap.
 */
export interface Chunk {
  symbol: string | null;
  startLine: number; // 1-based, inclusive
  endLine: number;
  content: string;
}

export const TS_LIKE = /\.(c|m)?(j|t)sx?$/;
const WINDOW = 60;
const OVERLAP = 10;
const MAX_CHUNK_LINES = 150;
const MIN_CHUNK_LINES = 3;

export function lineWindows(content: string, startLine = 1, symbol: string | null = null): Chunk[] {
  const lines = content.split("\n");
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += WINDOW - OVERLAP) {
    const slice = lines.slice(i, i + WINDOW);
    if (slice.join("").trim()) {
      out.push({ symbol, startLine: startLine + i, endLine: startLine + i + slice.length - 1, content: slice.join("\n") });
    }
    if (i + WINDOW >= lines.length) break;
  }
  return out;
}

function declarationName(node: ts.Statement): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
    return node.name.text;
  }
  if (ts.isVariableStatement(node)) {
    const names = node.declarationList.declarations.map((d) => (ts.isIdentifier(d.name) ? d.name.text : null)).filter(Boolean);
    return names.length ? names.join(", ") : null;
  }
  if (ts.isExportAssignment(node)) return "default";
  return null;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.(c|m)?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function chunkFile(path: string, content: string): Chunk[] {
  if (!TS_LIKE.test(path)) return lineWindows(content);

  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind(path));
  const lines = content.split("\n");
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const out: Chunk[] = [];
  let loose: ts.Statement[] = []; // imports, small statements: grouped together

  const flushLoose = () => {
    if (!loose.length) return;
    const start = lineOf(loose[0].getStart(sf));
    const end = lineOf(loose[loose.length - 1].getEnd());
    if (end - start + 1 >= MIN_CHUNK_LINES) out.push(...lineWindows(lines.slice(start - 1, end).join("\n"), start));
    loose = [];
  };

  for (const stmt of sf.statements) {
    const name = declarationName(stmt);
    if (!name || ts.isImportDeclaration(stmt)) {
      loose.push(stmt);
      continue;
    }
    flushLoose();
    const start = lineOf(stmt.getStart(sf, true)); // include leading JSDoc
    const end = lineOf(stmt.getEnd());
    const text = lines.slice(start - 1, end).join("\n");
    if (end - start + 1 > MAX_CHUNK_LINES) out.push(...lineWindows(text, start, name));
    else out.push({ symbol: name, startLine: start, endLine: end, content: text });
  }
  flushLoose();

  return out.length ? out : lineWindows(content);
}

/** Text that actually gets embedded: a header with the path and symbol carries meaning too. */
export function embeddingText(path: string, chunk: Chunk): string {
  const header = `// file: ${path}${chunk.symbol ? ` · ${chunk.symbol}` : ""}`;
  return `${header}\n${chunk.content}`.slice(0, 2000);
}
