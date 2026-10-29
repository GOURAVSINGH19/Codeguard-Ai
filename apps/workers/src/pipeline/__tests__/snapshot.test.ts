import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { DEFAULT_SNAPSHOT_LIMITS, SnapshotTooLargeError, downloadSnapshot, readTarGz, shouldKeep } from "../snapshot.js";

// ─── A tiny tar writer, so the tests use real archives ──────────────────────

type Entry = { path: string; data?: string | Buffer; type?: string; pax?: boolean; gnuLong?: boolean };

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.fill(0x20, 148, 156); // checksum is computed with this field as spaces
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function withPadding(data: Buffer): Buffer {
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([data, Buffer.alloc(pad)]);
}

function tarGz(entries: Entry[], root = "acme-api-abc1234/"): Buffer {
  const blocks: Buffer[] = [header("pax_global_header", 0, "g")];
  for (const e of entries) {
    const full = root + e.path;
    const data = typeof e.data === "string" ? Buffer.from(e.data) : e.data ?? Buffer.alloc(0);
    if (e.pax) {
      const record = ` path=${full}\n`;
      let len = record.length + 2;
      len = String(len).length + record.length;
      const pax = Buffer.from(`${len}${record}`);
      blocks.push(header("PaxHeader", pax.length, "x"), withPadding(pax));
    }
    if (e.gnuLong) {
      const long = Buffer.from(full + "\0");
      blocks.push(header("././@LongLink", long.length, "L"), withPadding(long));
    }
    blocks.push(header(e.pax || e.gnuLong ? "short-name" : full, data.length, e.type ?? "0"), withPadding(data));
  }
  blocks.push(Buffer.alloc(1024)); // end of archive
  return gzipSync(Buffer.concat(blocks));
}

/** Feed the archive in awkward chunk sizes to exercise the incremental reader. */
async function* chunks(buf: Buffer, size = 37) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

const longDir = "src/" + "very-long-folder-name/".repeat(8);

describe("readTarGz", () => {
  it("keeps text source files, strips GitHub's root folder, and reads long paths", async () => {
    const archive = tarGz([
      { path: "src/", type: "5" },
      { path: "src/index.ts", data: 'export const a = 1;\n' },
      { path: `${longDir}deep.ts`, data: "export const deep = true;\n", pax: true },
      { path: `${longDir}gnu.py`, data: "x = 1\n", gnuLong: true },
      { path: "README.md", data: "# docs" },
      { path: "node_modules/lib/index.js", data: "module.exports = 1" },
      { path: "pnpm-lock.yaml", data: "lockfileVersion: 9" },
      { path: "src/logo.ts", data: Buffer.from([0x89, 0x50, 0x00, 0x47]) },
      { path: "src/huge.json", data: "x".repeat(300 * 1024) },
    ]);
    const snap = await readTarGz(chunks(archive), "abc1234");

    expect([...snap.files.keys()].sort()).toEqual([`${longDir}deep.ts`, `${longDir}gnu.py`, "src/index.ts"].sort());
    expect(snap.files.get("src/index.ts")).toBe("export const a = 1;\n");
    expect(snap.truncated).toBe(false);
    expect(snap.skipped).toBe(5); // README, node_modules, lockfile, binary, huge
    expect(snap.downloadedBytes).toBe(archive.length);
  });

  it("stops and marks the snapshot truncated at the file or memory limit", async () => {
    const archive = tarGz([1, 2, 3, 4].map((n) => ({ path: `src/f${n}.ts`, data: `export const n = ${n};` })));
    const byCount = await readTarGz(chunks(archive), "s", { ...DEFAULT_SNAPSHOT_LIMITS, maxFiles: 2 });
    expect(byCount).toMatchObject({ truncated: true });
    expect(byCount.files.size).toBe(2);

    const bySize = await readTarGz(chunks(archive), "s", { ...DEFAULT_SNAPSHOT_LIMITS, maxKeptBytes: 30 });
    expect(bySize.truncated).toBe(true);
    expect(bySize.files.size).toBe(1);
  });

  it("gives up on a download larger than the limit", async () => {
    const archive = tarGz([{ path: "src/a.ts", data: "export const a = 1;" }]);
    await expect(readTarGz(chunks(archive), "s", { ...DEFAULT_SNAPSHOT_LIMITS, maxDownloadBytes: 50 })).rejects.toBeInstanceOf(SnapshotTooLargeError);
  });

  it("rejects a corrupt archive", async () => {
    await expect(readTarGz(chunks(Buffer.from("not a gzip file at all")), "s")).rejects.toThrow();
  });
});

describe("shouldKeep", () => {
  it.each([
    ["src/app.tsx", true],
    ["services/api/main.go", true],
    ["dist/app.js", false],
    ["web/.next/server.js", false],
    ["public/app.min.js", false],
    ["Cargo.lock", false],
    ["Makefile", false],
    ["docs/guide.md", false],
  ])("%s → %s", (path, keep) => {
    expect(shouldKeep(path, 100, 200_000)).toBe(keep);
  });
});

describe("downloadSnapshot", () => {
  it("asks GitHub for the tarball of the exact commit and streams it", async () => {
    const archive = tarGz([{ path: "src/a.ts", data: "export const a = 1;" }]);
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const octokit = {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return { data: chunks(archive, 100) };
      },
    };
    const snap = await downloadSnapshot(octokit as never, "acme", "api", "abc1234");
    expect(calls[0]).toMatchObject({ route: "GET /repos/{owner}/{repo}/tarball/{ref}", params: { owner: "acme", repo: "api", ref: "abc1234" } });
    expect(snap.files.get("src/a.ts")).toBe("export const a = 1;");
  });

  it("also accepts a buffered body", async () => {
    const archive = tarGz([{ path: "src/a.ts", data: "ok" }]);
    const ab = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length);
    const snap = await downloadSnapshot({ request: async () => ({ data: ab }) } as never, "o", "r", "s");
    expect(snap.files.get("src/a.ts")).toBe("ok");
  });
});
