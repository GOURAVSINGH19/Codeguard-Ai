"use client";

import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowsClockwise, CaretRight, GitBranch, Lock, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import PixelLoader from "./ui/PixelLoader";
import { INSTALL_URL } from "./InstallButton";

const PAGE_SIZE = 30;

interface GrantedRepo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  language: string | null;
  description: string | null;
  autoReviewEnabled: boolean;
}

/**
 * Right-hand drawer opened by "New review": lists only the repositories the
 * GitHub App was granted during install ("All repositories" → all of them,
 * "Only select repositories" → just those). Picking one opens its PRs on the
 * dashboard (/?repo=owner/name).
 */
export default function RepoDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<GrantedRepo[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  // Which request (query + refresh count) the list currently reflects.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const key = `${query}|${version}`;
  const loading = loadedKey !== key;
  // Pull the current grant from GitHub on the first open and on manual refresh.
  const synced = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const url = (p: number, sync: boolean) =>
    `/api/github/app/repositories?page=${p}&pageSize=${PAGE_SIZE}${query ? `&q=${encodeURIComponent(query)}` : ""}${sync ? "&sync=1" : ""}`;

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const sync = !synced.current;
    synced.current = true;
    fetch(url(1, sync), { cache: "no-store" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || "Failed to load repositories");
        if (cancelled) return;
        setError(null);
        setRepos(json.repos ?? []);
        setPage(1);
        setHasMore(!!json.hasMore);
        setTotal(json.total ?? 0);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load repositories"))
      .finally(() => !cancelled && setLoadedKey(key));
    return () => {
      cancelled = true;
    };
    // url() is derived from query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(url(page + 1, false), { cache: "no-store" });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || "Failed to load repositories");
      setRepos((prev) => [...prev, ...(json.repos ?? [])]);
      setPage((p) => p + 1);
      setHasMore(!!json.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load repositories");
    } finally {
      setLoadingMore(false);
    }
  };

  const pick = (r: GrantedRepo) => {
    onClose();
    router.push(`/?repo=${encodeURIComponent(r.fullName)}`);
  };

  return (
    <div className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-[var(--cg-overlay)] transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Choose a repository"
        className={`absolute right-0 top-0 h-full w-full sm:w-[420px] bg-cg-panel border-l border-cg-border flex flex-col shadow-2xl transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="h-12 px-4 flex items-center justify-between border-b border-cg-border shrink-0">
          <h2 className="text-sm font-semibold text-cg-text">New review</h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                synced.current = false;
                setVersion((v) => v + 1);
              }}
              disabled={loading}
              aria-label="Refresh from GitHub"
              title="Refresh from GitHub"
              className="h-7 w-7 flex items-center justify-center rounded text-cg-subtle hover:text-cg-text hover:bg-cg-raised transition disabled:opacity-50"
            >
              <ArrowsClockwise size={15} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="h-7 w-7 flex items-center justify-center rounded text-cg-subtle hover:text-cg-text hover:bg-cg-raised transition"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="px-4 pt-3 pb-2 flex flex-col gap-2 shrink-0">
          <p className="text-xs text-cg-subtle">Repositories you gave CodeGuard access to on GitHub.</p>
          <div className="relative">
            <MagnifyingGlass size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cg-subtle" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repositories..."
              className="w-full h-8 pl-8 pr-3 rounded border border-cg-border bg-transparent text-sm text-cg-text placeholder:text-cg-subtle focus:outline-none focus:border-cg-muted"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {loading ? (
            <div className="py-10 flex justify-center">
              <PixelLoader label="Loading repositories" />
            </div>
          ) : error ? (
            <p className="py-10 px-4 text-center text-sm text-rose-400">{error}</p>
          ) : repos.length === 0 ? (
            <div className="py-10 px-4 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-cg-muted">{query ? "No matching repositories." : "CodeGuard has no repositories yet."}</p>
              {!query && (
                <p className="text-xs text-cg-subtle">Grant access to repositories on GitHub, then refresh.</p>
              )}
            </div>
          ) : (
            <ul className="flex flex-col">
              {repos.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => pick(r)}
                    className="w-full flex items-center gap-3 px-2 py-2.5 rounded text-left hover:bg-cg-raised transition-colors group"
                  >
                    <GitBranch size={16} className="text-cg-subtle shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-cg-text truncate flex items-center gap-1.5">
                        <span className="text-cg-muted">{r.owner}/</span>
                        <span className="font-medium">{r.name}</span>
                        {r.private && <Lock size={12} className="text-cg-subtle shrink-0" />}
                      </p>
                      {(r.description || r.language) && (
                        <p className="text-xs text-cg-subtle truncate mt-0.5">
                          {[r.language, r.description].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    {r.autoReviewEnabled && (
                      <span className="px-1.5 py-px rounded bg-emerald-500/10 text-[11px] text-emerald-400 shrink-0">Auto</span>
                    )}
                    <CaretRight size={13} className="text-cg-subtle opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && hasMore && (
            <div className="flex items-center justify-between px-2 pt-2 text-xs text-cg-subtle">
              <span className="tabular-nums">
                Showing {repos.length} of {total}
              </span>
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="h-7 px-2.5 rounded border border-cg-border text-cg-muted hover:text-cg-text hover:bg-cg-raised transition disabled:pointer-events-none"
              >
                {loadingMore ? <PixelLoader className="!text-xs" /> : "Load more"}
              </button>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-cg-border shrink-0">
          <a
            href={INSTALL_URL}
            target="_blank"
            rel="noreferrer"
            className="h-8 w-full flex items-center justify-center gap-1.5 rounded border border-cg-border text-sm text-cg-muted hover:text-cg-text hover:bg-cg-raised transition"
          >
            <Plus size={14} />
            Add or remove repositories on GitHub
          </a>
        </div>
      </aside>
    </div>
  );
}
