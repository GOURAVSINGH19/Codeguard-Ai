import { Readable, pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import type { Octokit } from "octokit";

/**
 * Read-only snapshot of a repository at one commit, for a single review.
 *
 * One request downloads GitHub's tarball of the commit; it is streamed through
 * gunzip and a small tar reader straight into memory, keeping only text source
 * files. Nothing is written to disk and nothing is executed, so there is no
 * cleanup step and no sandbox to escape: the snapshot is garbage once the run
 * ends. Limits apply while streaming, so a huge repository is cut off early.
 */

export interface RepoSnapshot {
  sha: string;
  /** Repository-relative path → file text. */
  files: Map<string, string>;
  /** A limit was hit: some files are missing, so callers should still fall back to other sources. */
  truncated: boolean;
  downloadedBytes: number;
  keptBytes: number;
  /** Files seen but not kept (filtered, binary or too big). */
  skipped: number;
  durationMs: number;
}

export interface SnapshotLimits {
  /** Compressed bytes to download before giving up. */
  maxDownloadBytes: number;
  /** Text kept in memory; past this the snapshot is truncated. */
  maxKeptBytes: number;
  /** Larger files are skipped (generated or data files, not code to review). */
  maxFileBytes: number;
  maxFiles: number;
  timeoutMs: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxDownloadBytes: 100 * 1024 * 1024,
  maxKeptBytes: 64 * 1024 * 1024,
  maxFileBytes: 200 * 1024,
  maxFiles: 20_000,
  timeoutMs: 60_000,
};

export class SnapshotTooLargeError extends Error {
  constructor(limit: number) {
    super(`repository tarball is larger than ${Math.round(limit / 1024 / 1024)} MB`);
    this.name = "SnapshotTooLargeError";
  }
}

// ─── What to keep ────────────────────────────────────────────────────────────

const KEEP_EXTENSIONS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "go", "rs", "java", "kt", "kts", "scala", "swift", "rb", "php", "cs",
  "c", "h", "cc", "cpp", "hpp", "m", "sql", "graphql", "gql", "sh",
  "json", "yaml", "yml", "toml",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", "coverage", "vendor", "__pycache__", ".venv", "venv", "target", ".gradle"]);
const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$|\.map$|\.snap$/;

export function shouldKeep(path: string, size: number, maxFileBytes: number): boolean {
  if (size > maxFileBytes) return false;
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (SKIP_FILES.test(path)) return false;
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf(".");
  return dot > 0 && KEEP_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8_000).includes(0);
}

// ─── Tar reading (ustar + pax + GNU long names) ─────────────────────────────

const BLOCK = 512;

function readString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/** Octal, or base-256 when the high bit is set (files over 8 GB). */
function readSize(block: Buffer): number {
  const field = block.subarray(124, 136);
  if (field[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return n;
  }
  return parseInt(readString(block, 124, 12).trim() || "0", 8);
}

/** `path=` from a pax extended header ("<len> key=value\n" records). */
function paxPath(data: Buffer): string | null {
  const text = data.toString("utf8");
  for (const record of text.split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(record);
    if (m) return m[1];
  }
  return null;
}

/** GitHub tarballs wrap everything in "<owner>-<repo>-<sha>/". */
function stripRoot(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(slash + 1);
}

/**
 * Incremental tar reader: feed it chunks of any size. Wanted files are
 * collected whole; everything else is skipped without being buffered.
 */
export class TarReader {
  private buf: Buffer = Buffer.alloc(0);
  private mode: "header" | "data" | "end" = "header";
  private remaining = 0;
  private padding = 0;
  private parts: Buffer[] | null = null;
  private current: { kind: "file" | "pax" | "longname"; path: string } | null = null;
  private nextPath: string | null = null;

  constructor(
    private readonly wants: (path: string, size: number) => boolean,
    /** Return false to stop reading. */
    private readonly onFile: (path: string, data: Buffer) => boolean
  ) {}

  get finished(): boolean {
    return this.mode === "end";
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    let offset = 0;
    while (this.mode !== "end") {
      if (this.mode === "header") {
        if (this.buf.length - offset < BLOCK) break;
        const header = this.buf.subarray(offset, offset + BLOCK);
        offset += BLOCK;
        if (header.every((b) => b === 0)) {
          this.mode = "end";
          break;
        }
        this.startEntry(header);
        continue;
      }
      // data, then padding up to the next 512-byte boundary
      const available = this.buf.length - offset;
      if (available === 0) break;
      if (this.remaining > 0) {
        const take = Math.min(available, this.remaining);
        if (this.parts) this.parts.push(Buffer.from(this.buf.subarray(offset, offset + take)));
        offset += take;
        this.remaining -= take;
        continue;
      }
      const pad = Math.min(available, this.padding);
      offset += pad;
      this.padding -= pad;
      if (this.padding === 0) this.finishEntry();
    }
    this.buf = this.buf.subarray(offset);
  }

  private startEntry(header: Buffer): void {
    const size = readSize(header);
    const type = String.fromCharCode(header[156] || 48); // "\0" means regular file
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = this.nextPath ?? (prefix ? `${prefix}/${name}` : name);

    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.parts = null;
    this.current = null;

    if (type === "x") {
      this.current = { kind: "pax", path: "" };
      this.parts = [];
    } else if (type === "L") {
      this.current = { kind: "longname", path: "" };
      this.parts = [];
    } else {
      this.nextPath = null; // a long name applies to one entry only
      const rel = stripRoot(path);
      if ((type === "0" || type === "7") && rel && this.wants(rel, size)) {
        this.current = { kind: "file", path: rel };
        this.parts = [];
      }
      // "g" (global pax), directories, links: skipped
    }
    if (this.remaining === 0 && this.padding === 0) this.finishEntry();
    else this.mode = "data";
  }

  private finishEntry(): void {
    this.mode = "header";
    const entry = this.current;
    const data = this.parts ? Buffer.concat(this.parts) : null;
    this.current = null;
    this.parts = null;
    if (!entry || !data) return;
    if (entry.kind === "pax") this.nextPath = paxPath(data);
    else if (entry.kind === "longname") this.nextPath = data.toString("utf8").replace(/\0+$/, "");
    else if (!this.onFile(entry.path, data)) this.mode = "end";
  }
}

// ─── Gzip stream → snapshot ──────────────────────────────────────────────────

/** Read a gzipped tarball stream into a snapshot, applying the limits as it streams. */
export async function readTarGz(source: AsyncIterable<Uint8Array>, sha: string, limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS): Promise<RepoSnapshot> {
  const started = Date.now();
  const files = new Map<string, string>();
  let downloadedBytes = 0;
  let keptBytes = 0;
  let skipped = 0;
  let truncated = false;

  async function* counted() {
    for await (const chunk of source) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > limits.maxDownloadBytes) throw new SnapshotTooLargeError(limits.maxDownloadBytes);
      yield chunk;
    }
  }

  const reader = new TarReader(
    (path, size) => {
      const keep = shouldKeep(path, size, limits.maxFileBytes);
      if (!keep) skipped++;
      return keep;
    },
    (path, data) => {
      if (looksBinary(data)) {
        skipped++;
        return true;
      }
      if (files.size >= limits.maxFiles || keptBytes + data.length > limits.maxKeptBytes) {
        truncated = true;
        return false;
      }
      files.set(path, data.toString("utf8"));
      keptBytes += data.length;
      return true;
    }
  );

  let failure: Error | null = null;
  const gunzip = pipeline(Readable.from(counted()), createGunzip(), (err) => {
    if (err && !failure) failure = err;
  });
  try {
    for await (const chunk of gunzip) {
      reader.push(chunk as Buffer);
      if (reader.finished) break;
    }
  } catch (err) {
    failure ??= err as Error;
  } finally {
    gunzip.destroy();
  }
  // Stopping early on purpose (end of archive, or a limit) is not a failure.
  if (failure && !reader.finished) throw failure;

  return { sha, files, truncated, downloadedBytes, keptBytes, skipped, durationMs: Date.now() - started };
}

/** Normalise what octokit returns (web stream, Node stream, or a whole buffer) into chunks. */
export function toChunks(body: unknown): AsyncIterable<Uint8Array> {
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") return body as AsyncIterable<Uint8Array>;
  const whole = body instanceof ArrayBuffer ? new Uint8Array(body) : body instanceof Uint8Array ? body : null;
  if (!whole) throw new Error("unexpected tarball response body");
  return (async function* () {
    yield whole;
  })();
}

/** Download the tarball of `sha` and read it into a snapshot. */
export async function downloadSnapshot(
  octokit: Pick<Octokit, "request">,
  owner: string,
  repo: string,
  sha: string,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS
): Promise<RepoSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
      owner,
      repo,
      ref: sha,
      // Stream the body instead of buffering the whole archive.
      request: { signal: controller.signal, parseSuccessResponseBody: false },
    });
    return await readTarGz(toChunks(res.data), sha, limits);
  } finally {
    clearTimeout(timer);
    controller.abort(); // stop the download if we stopped reading early
  }
}
