import { describe, it, expect } from "vitest";
import { DependencyGraph } from "../DependencyGraph";

/**
 * Graph shape used across tests:
 *
 *   utils.ts  ←  auth.ts  ←  middleware.ts  ←  route.ts
 *   utils.ts  ←  db.ts
 *
 * Reading: auth.ts imports utils.ts
 *          middleware.ts imports auth.ts
 *          route.ts imports middleware.ts
 *          db.ts imports utils.ts
 */
function buildTestGraph(): DependencyGraph {
  const graph = new DependencyGraph();
  graph.addFile("src/utils.ts", []);                          // leaf — imports nothing
  graph.addFile("src/auth.ts", ["src/utils.ts"]);             // imports utils
  graph.addFile("src/db.ts", ["src/utils.ts"]);               // also imports utils
  graph.addFile("src/middleware.ts", ["src/auth.ts"]);        // imports auth
  graph.addFile("src/route.ts", ["src/middleware.ts"]);       // imports middleware
  graph.addFile("src/unrelated.ts", []);                      // no connection to utils chain
  return graph;
}

describe("DependencyGraph", () => {

  describe("addFile()", () => {
    it("tracks node count correctly", () => {
      const graph = buildTestGraph();
      expect(graph.size).toBe(6);
    });

    it("records forward edges (imports)", () => {
      const graph = buildTestGraph();
      const deps = graph.getDirectDependencies("src/auth.ts");
      expect(deps).toContain("src/utils.ts");
    });

    it("records reverse edges (importedBy)", () => {
      const graph = buildTestGraph();
      const importers = graph.getDirectImporters("src/utils.ts");
      expect(importers).toContain("src/auth.ts");
      expect(importers).toContain("src/db.ts");
    });

    it("auto-creates nodes for files that appear only as imports", () => {
      const graph = new DependencyGraph();
      graph.addFile("src/consumer.ts", ["src/not-yet-added.ts"]);
      expect(graph.size).toBe(2); // both nodes created
    });
  });

  describe("getBlastRadius()", () => {
    it("includes the changed file itself at depth 0", () => {
      const graph = buildTestGraph();
      const radius = graph.getBlastRadius(["src/utils.ts"]);
      expect(radius.get("src/utils.ts")).toBe(0);
    });

    it("includes direct importers at depth 1", () => {
      const graph = buildTestGraph();
      const radius = graph.getBlastRadius(["src/utils.ts"]);
      expect(radius.get("src/auth.ts")).toBe(1);
      expect(radius.get("src/db.ts")).toBe(1);
    });

    it("includes transitive importers at correct depth", () => {
      const graph = buildTestGraph();
      const radius = graph.getBlastRadius(["src/utils.ts"]);
      expect(radius.get("src/middleware.ts")).toBe(2);
      expect(radius.get("src/route.ts")).toBe(3);
    });

    it("does NOT include unrelated files", () => {
      const graph = buildTestGraph();
      const radius = graph.getBlastRadius(["src/utils.ts"]);
      expect(radius.has("src/unrelated.ts")).toBe(false);
    });

    it("respects maxDepth — stops BFS at the depth limit", () => {
      const graph = buildTestGraph();
      // maxDepth=1: only utils.ts (depth 0) + direct importers (depth 1)
      const radius = graph.getBlastRadius(["src/utils.ts"], 1);
      expect(radius.has("src/utils.ts")).toBe(true);
      expect(radius.has("src/auth.ts")).toBe(true);
      expect(radius.has("src/db.ts")).toBe(true);
      // depth 2+ should NOT be included
      expect(radius.has("src/middleware.ts")).toBe(false);
      expect(radius.has("src/route.ts")).toBe(false);
    });

    it("handles multiple changed files", () => {
      const graph = buildTestGraph();
      // Both utils.ts and middleware.ts changed
      const radius = graph.getBlastRadius(["src/utils.ts", "src/middleware.ts"]);
      // route.ts is 1 hop from middleware.ts AND 3 hops from utils.ts
      // BFS records the SHORTEST distance first
      expect(radius.get("src/route.ts")).toBe(1); // via middleware → route
    });

    it("returns empty map for a file with no importers", () => {
      const graph = buildTestGraph();
      // route.ts is a leaf — nothing imports it
      const radius = graph.getBlastRadius(["src/route.ts"]);
      expect(radius.size).toBe(1); // only route.ts itself
    });

    it("handles a file not in the graph gracefully", () => {
      const graph = buildTestGraph();
      const radius = graph.getBlastRadius(["src/nonexistent.ts"]);
      // The unknown file is added with depth 0 but has no edges
      expect(radius.size).toBe(1);
      expect(radius.get("src/nonexistent.ts")).toBe(0);
    });
  });

  describe("rankFilesForReview()", () => {
    it("puts directly changed files first", () => {
      const graph = buildTestGraph();
      const changed = new Map([["src/utils.ts", 50]]);
      const ranked = graph.rankFilesForReview(changed);
      expect(ranked[0].path).toBe("src/utils.ts");
      expect(ranked[0].directlyChanged).toBe(true);
    });

    it("files closer to the change rank higher than distant ones", () => {
      const graph = buildTestGraph();
      const changed = new Map([["src/utils.ts", 10]]);
      const ranked = graph.rankFilesForReview(changed);
      const authIndex = ranked.findIndex((r) => r.path === "src/auth.ts");
      const routeIndex = ranked.findIndex((r) => r.path === "src/route.ts");
      expect(authIndex).toBeLessThan(routeIndex);
    });

    it("respects maxFiles limit", () => {
      const graph = buildTestGraph();
      const changed = new Map([["src/utils.ts", 10]]);
      const ranked = graph.rankFilesForReview(changed, 3, 2);
      expect(ranked.length).toBeLessThanOrEqual(2);
    });

    it("unrelated files are never included", () => {
      const graph = buildTestGraph();
      const changed = new Map([["src/utils.ts", 10]]);
      const ranked = graph.rankFilesForReview(changed);
      const paths = ranked.map((r) => r.path);
      expect(paths).not.toContain("src/unrelated.ts");
    });
  });
});
