import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetEnvCache } from "@codeguard/config";

// prepare.ts pulls in the db, GitHub, RAG and tree-sitter; only the snapshot pieces are under test.
vi.mock("@codeguard/db", () => ({ db: {}, codeChunks: {}, eq: vi.fn(), and: vi.fn(), or: vi.fn(), inArray: vi.fn(), notInArray: vi.fn(), ilike: vi.fn() }));
vi.mock("../../store.js", () => ({}));
vi.mock("../../../github/octokit.js", () => ({ getRepoOctokit: vi.fn() }));
vi.mock("../../../queue/consumer.js", () => ({ PermanentError: class extends Error {} }));
vi.mock("../../../rag/RAGService.js", () => ({ RAGService: vi.fn() }));
vi.mock("../../../ai/EmbeddingService.js", () => ({ EmbeddingService: { fromEnv: vi.fn() } }));
vi.mock("../../../analyzers/ASTChunker.js", () => ({ astChunker: { isSupported: () => false } }));
const getFilesText = vi.fn();
vi.mock("../../github-data.js", () => ({ getFilesText: (...args: unknown[]) => getFilesText(...args) }));
const downloadSnapshot = vi.fn();
vi.mock("../../snapshot.js", () => ({ DEFAULT_SNAPSHOT_LIMITS: { maxDownloadBytes: 1 }, downloadSnapshot: (...args: unknown[]) => downloadSnapshot(...args) }));

const { downloadSnapshotNode, readRepoFiles } = await import("../prepare.js");
const { initialState } = await import("../../state.js");
type State = ReturnType<typeof initialState>;

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silent };

function state(repoSizeKb = 1_000): State {
  const s = initialState({ owner: "acme", repo: "api", pullNumber: 1, userId: null, triggeredBy: "webhook", requestedAt: "" }, silent);
  s.headSha = "abc1234";
  s.pr = { base: { repo: { size: repoSizeKb } } } as State["pr"];
  return s;
}

const snapshot = (truncated = false) => ({ sha: "abc1234", files: new Map([["src/a.ts", "A"]]), truncated, downloadedBytes: 1, keptBytes: 1, skipped: 0, durationMs: 1 });

beforeEach(() => {
  getFilesText.mockReset().mockResolvedValue(new Map([["src/b.ts", "B"]]));
  downloadSnapshot.mockReset().mockResolvedValue(snapshot());
});
afterEach(() => {
  delete process.env.REVIEW_SNAPSHOT;
  delete process.env.REVIEW_SNAPSHOT_MAX_MB;
  resetEnvCache();
});

describe("download_snapshot", () => {
  it("downloads the exact head commit and keeps the snapshot on the run", async () => {
    const s = state();
    await downloadSnapshotNode.run(s);
    expect(downloadSnapshot).toHaveBeenCalledWith(undefined, "acme", "api", "abc1234", expect.objectContaining({ maxDownloadBytes: 100 * 1024 * 1024 }));
    expect(s.snapshot?.files.get("src/a.ts")).toBe("A");
  });

  it("is skipped when turned off", async () => {
    process.env.REVIEW_SNAPSHOT = "false";
    resetEnvCache();
    const s = state();
    await downloadSnapshotNode.run(s);
    expect(downloadSnapshot).not.toHaveBeenCalled();
    expect(s.snapshot).toBeNull();
  });

  it("does not even start for a repository far over the size limit", async () => {
    process.env.REVIEW_SNAPSHOT_MAX_MB = "10";
    resetEnvCache();
    const s = state(50 * 1024); // 50 MB of git history > 4 × 10 MB
    await downloadSnapshotNode.run(s);
    expect(downloadSnapshot).not.toHaveBeenCalled();
  });

  it("is optional: a failed download leaves the review on the API path", () => {
    expect(downloadSnapshotNode.optional).toBe(true);
  });
});

describe("readRepoFiles", () => {
  it("reads from a complete snapshot without calling the API", async () => {
    const s = state();
    s.snapshot = snapshot();
    const files = await readRepoFiles(s, ["src/a.ts", "assets/logo.png"]);
    expect([...files]).toEqual([["src/a.ts", "A"]]);
    expect(getFilesText).not.toHaveBeenCalled();
  });

  it("asks the API only for what a truncated snapshot lacks", async () => {
    const s = state();
    s.snapshot = snapshot(true);
    const files = await readRepoFiles(s, ["src/a.ts", "src/b.ts"]);
    expect(getFilesText).toHaveBeenCalledWith(undefined, "acme", "api", ["src/b.ts"], "abc1234");
    expect(files.get("src/a.ts")).toBe("A");
    expect(files.get("src/b.ts")).toBe("B");
  });

  it("uses the API for everything without a snapshot", async () => {
    const files = await readRepoFiles(state(), ["src/b.ts"]);
    expect(files.get("src/b.ts")).toBe("B");
  });
});
