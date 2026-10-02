"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { CaretLeft, CaretRight, GitPullRequest, MagnifyingGlass, Robot, X } from "@phosphor-icons/react";
import PixelLoader from "./ui/PixelLoader";

type Severity = "critical" | "high" | "medium" | "low";

interface HistoryRow {
  id: string;
  title: string | null;
  score: number | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  reviewType: string;
  createdAt: string;
  repo: string | null;
  prNumber: number | null;
  issues: { severity: string }[];
}

const PAGE_SIZE = 15;

const TABS = [
  { id: "", label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "completed", label: "Passed" },
  { id: "working", label: "In progress" },
  { id: "failed", label: "Failed" },
] as const;

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-rose-500",
  high: "bg-orange-400",
  medium: "bg-amber-300",
  low: "bg-sky-400",
};

function scoreClass(score: number) {
  return score >= 8 ? "text-emerald-400" : score >= 5 ? "text-amber-300" : "text-rose-400";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Every review the user can see, newest first, for the Reports page. */
export default function ReviewHistory() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ key: string; rows: HistoryRow[]; total: number; error: string | null } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const key = `${tab}|${query}|${page}`;
  const loading = data?.key !== key;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (tab) params.set("group", tab);
    if (query) params.set("q", query);
    fetch(`/api/reviews?${params}`, { cache: "no-store" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || "Failed to load reviews");
        if (!cancelled) setData({ key, rows: json.reviews ?? [], total: json.total ?? 0, error: null });
      })
      .catch((e) => {
        if (!cancelled) setData({ key, rows: [], total: 0, error: e instanceof Error ? e.message : "Failed to load reviews" });
      });
    return () => {
      cancelled = true;
    };
  }, [key, tab, query, page]);

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="rounded-md border border-cg-border">
      <div className="px-4 pt-3.5 pb-3 flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-cg-text">Review history</h2>
            <p className="text-xs text-cg-subtle mt-0.5">Every pull request review, newest first.</p>
          </div>
          <div className="relative w-full sm:w-64">
            <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cg-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or repository..."
              className="w-full h-8 pl-8 pr-7 rounded border border-cg-border bg-transparent text-sm text-cg-text placeholder:text-cg-subtle focus:outline-none focus:border-cg-muted"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-cg-subtle hover:text-cg-text"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setPage(1);
              }}
              className={`h-7 px-2.5 rounded text-xs whitespace-nowrap transition ${
                tab === t.id ? "bg-cg-raised text-cg-text" : "text-cg-subtle hover:text-cg-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Column headings (desktop) */}
      <div className="hidden md:grid grid-cols-[1fr_150px_90px_110px] gap-4 px-6 py-2 border-y border-cg-border text-[11px] uppercase tracking-wider text-cg-subtle">
        <span>Pull request</span>
        <span>Issues</span>
        <span className="text-right">Score</span>
        <span className="text-right">Date</span>
      </div>

      <div className="px-2 py-2 min-h-[120px]">
        {loading && rows.length === 0 ? (
          <div className="py-10 flex justify-center">
            <PixelLoader label="Loading reviews" />
          </div>
        ) : data?.error ? (
          <p className="py-10 text-center text-sm text-rose-400">{data.error}</p>
        ) : rows.length === 0 ? (
          <div className="py-10 flex flex-col items-center gap-2 text-sm text-cg-subtle">
            <GitPullRequest size={20} />
            {query ? "No reviews match your search." : "No reviews here yet."}
          </div>
        ) : (
          <ul className={`flex flex-col transition-opacity ${loading ? "opacity-50" : ""}`}>
            {rows.map((r) => (
              <HistoryItem key={r.id} review={r} />
            ))}
          </ul>
        )}
      </div>

      {totalPages > 1 && (
        <div className="px-4 py-2.5 border-t border-cg-border flex items-center justify-between text-xs text-cg-subtle">
          <span className="tabular-nums">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => p - 1)}
              disabled={page <= 1 || loading}
              aria-label="Previous page"
              className="h-7 w-7 flex items-center justify-center rounded border border-cg-border hover:text-cg-text hover:bg-cg-raised transition disabled:opacity-40 disabled:pointer-events-none"
            >
              <CaretLeft size={13} />
            </button>
            <span className="px-2 tabular-nums">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages || loading}
              aria-label="Next page"
              className="h-7 w-7 flex items-center justify-center rounded border border-cg-border hover:text-cg-text hover:bg-cg-raised transition disabled:opacity-40 disabled:pointer-events-none"
            >
              <CaretRight size={13} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function HistoryItem({ review: r }: { review: HistoryRow }) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<Severity, number>;
  for (const i of r.issues) if (i.severity in counts) counts[i.severity as Severity]++;
  const running = r.status === "pending" || r.status === "in_progress";

  return (
    <li>
      <Link
        href={`/reviews/${r.id}`}
        className="grid grid-cols-[1fr_auto] md:grid-cols-[1fr_150px_90px_110px] items-center gap-x-4 gap-y-1 px-4 py-2.5 rounded hover:bg-cg-raised transition-colors"
      >
        <div className="min-w-0">
          <p className="text-sm text-cg-text truncate flex items-center gap-1.5">
            {r.reviewType === "automated" && <Robot size={13} className="text-cg-subtle shrink-0" aria-label="Auto-review" />}
            {r.title || "Untitled review"}
          </p>
          <p className="text-xs text-cg-subtle truncate mt-0.5">
            {r.repo ? (
              <>
                {r.repo}
                {r.prNumber != null && <span> #{r.prNumber}</span>}
              </>
            ) : (
              "Code snippet"
            )}
            <span className="md:hidden"> · {formatDate(r.createdAt)}</span>
          </p>
        </div>

        <div className="hidden md:flex items-center gap-2.5 text-xs text-cg-muted tabular-nums">
          {r.issues.length === 0 ? (
            <span className="text-cg-subtle">{r.status === "completed" ? "None" : "—"}</span>
          ) : (
            (Object.keys(counts) as Severity[])
              .filter((s) => counts[s] > 0)
              .map((s) => (
                <span key={s} className="flex items-center gap-1" title={`${counts[s]} ${s}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_DOT[s]}`} />
                  {counts[s]}
                </span>
              ))
          )}
        </div>

        <div className="text-right">
          {running ? (
            <PixelLoader label="Reviewing" className="!text-xs" />
          ) : r.status === "failed" ? (
            <span className="text-xs text-rose-400">Failed</span>
          ) : r.score !== null ? (
            <span className={`text-sm font-medium tabular-nums ${scoreClass(r.score)}`}>
              {r.score.toFixed(1)}
              <span className="text-xs text-cg-subtle font-normal">/10</span>
            </span>
          ) : (
            <span className="text-cg-subtle">—</span>
          )}
        </div>

        <span className="hidden md:block text-right text-xs text-cg-subtle tabular-nums">{formatDate(r.createdAt)}</span>
      </Link>
    </li>
  );
}
