/** A row from GET /api/github/app/installations. */
export interface InstallationRow {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
  status: "active" | "suspended" | "deleted";
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
}

// Once installed, the answer rarely changes; until then, re-check sooner.
const TTL_INSTALLED_MS = 5 * 60 * 1000;
const TTL_NONE_MS = 30 * 1000;

let cache: { at: number; ttl: number; promise: Promise<InstallationRow[]> } | null = null;

/**
 * Installations of the signed-in user, shared by every component on the page:
 * concurrent callers get the same request, and the result is reused for a
 * short while. Pass `fresh` to bypass the cache (polling, after uninstall).
 * Failed requests resolve to [] and are not cached.
 */
export function getInstallations({ fresh = false }: { fresh?: boolean } = {}): Promise<InstallationRow[]> {
  if (!fresh && cache && Date.now() - cache.at < cache.ttl) return cache.promise;

  const entry = { at: Date.now(), ttl: TTL_NONE_MS, promise: Promise.resolve<InstallationRow[]>([]) };
  entry.promise = fetch("/api/github/app/installations", { cache: "no-store" })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = ((await r.json()).installations ?? []) as InstallationRow[];
      if (rows.some((i) => i.status === "active")) entry.ttl = TTL_INSTALLED_MS;
      return rows;
    })
    .catch(() => {
      if (cache === entry) cache = null;
      return [];
    });
  cache = entry;
  return entry.promise;
}

export function hasActive(rows: InstallationRow[]): boolean {
  return rows.some((i) => i.status === "active");
}

export function invalidateInstallations(): void {
  cache = null;
}
