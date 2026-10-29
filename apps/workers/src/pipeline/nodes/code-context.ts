import {
  breakingChangeFindings,
  buildContextPacks,
  changedFunctionNames,
  classifyFile,
  detectSignatureChanges,
  findCallSites,
  findDefinitions,
  formatCodeContext,
  identifiersUsed,
} from "@codeguard/review-engine";
import type { PackStage, PipelineStep, SourceFile } from "@codeguard/review-engine";
import type { ReviewRunState } from "../state.js";

/** Files the changed code imports (searched for definitions). */
const MAX_DEPENDENCY_FILES = 15;
/** Files that import the changed code (searched for call sites). */
const MAX_IMPORTER_FILES = 20;
/** Stages whose prompt gets the code context. Alignment and testing don't need it. */
const STAGES: PackStage[] = ["quality", "security", "verify"];

/** Reads repository files at the reviewed commit; missing ones are left out. */
export type RepoFileReader = (s: ReviewRunState, paths: string[]) => Promise<Map<string, string>>;

/**
 * build_code_context: show the model the code the diff touches but does not
 * contain — definitions of what the added lines use, and the call sites of
 * the functions the PR changes — and flag callers outside the PR that a
 * signature change breaks.
 *
 * Runs after build_software_graph (it needs the import graph). Without a graph
 * it still looks inside the PR's own files. Kept free of the database so the
 * eval harness can run it with a fake reader.
 */
export function codeContextStep(readFiles: RepoFileReader): PipelineStep<ReviewRunState> {
  return {
    name: "build_code_context",
    optional: true,
    async run(s) {
      const prFiles = new Set(s.allFiles.map((f) => f.filename));
      const changedSource = s.files.filter((f) => classifyFile(f.filename) === "source").map((f) => f.filename);
      const graph = s.graph;
      const unique = (paths: string[]) => [...new Set(paths)];

      const dependencies = graph ? unique(changedSource.flatMap((f) => graph.getDirectDependencies(f))).filter((p) => !prFiles.has(p)).slice(0, MAX_DEPENDENCY_FILES) : [];
      const importers = graph ? unique(changedSource.flatMap((f) => graph.getDirectImporters(f))).filter((p) => !prFiles.has(p)).slice(0, MAX_IMPORTER_FILES) : [];
      const fetched = await readFiles(s, unique([...dependencies, ...importers]));

      const own: SourceFile[] = [...s.headContents].map(([path, text]) => ({ path, text }));
      const pick = (paths: string[]) => paths.filter((p) => fetched.has(p)).map((p) => ({ path: p, text: fetched.get(p)! }));

      const names = unique([
        ...s.changedSymbols.filter((c) => c.kind !== "block" && c.kind !== "type" && c.kind !== "interface").map((c) => c.name),
        ...changedFunctionNames(s.files),
      ]);
      const signatureChanges = detectSignatureChanges(s.files);
      s.codeContext = {
        // Imported files first: a definition there is what the diff relies on.
        definitions: findDefinitions(identifiersUsed(s.files), [...pick(dependencies), ...own]),
        callSites: findCallSites(names, [...pick(importers), ...own], prFiles),
        signatureChanges,
      };

      const breaking = breakingChangeFindings(signatureChanges, s.codeContext.callSites);
      if (breaking.length > 0) s.findingsBySource.blast_radius = [...(s.findingsBySource.blast_radius ?? []), ...breaking];

      const text = formatCodeContext(s.codeContext);
      if (!text) return;
      s.packs ??= buildContextPacks({ files: s.files });
      for (const stage of STAGES) {
        const pack = s.packs[stage];
        pack.relatedCode = [text, pack.relatedCode].filter(Boolean).join("\n\n");
      }
      s.log.info("code context", {
        definitions: s.codeContext.definitions.length,
        callSites: s.codeContext.callSites.length,
        signatureChanges: signatureChanges.length,
        breaking: breaking.length,
        chars: text.length,
      });
    },
  };
}
