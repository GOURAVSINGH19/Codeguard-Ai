"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowClockwise, ArrowSquareOut, GitPullRequest, Lock, X } from "@phosphor-icons/react";
import PixelLoader from "./ui/PixelLoader";
import { pollReview } from "@/lib/poll-review";

interface PullReview {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  score: number | null;
  createdAt: string;
  /** Reviewed an older commit than the PR's current head. */
  outdated: boolean;
}

interface Pull {
  number: number;
  title: string;
  authorLogin: string;
  headBranch: string;
  baseBranch: string;
  htmlUrl: string;
  createdAt: string;
  review: PullReview | null;
}

interface RepoInfo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  autoReviewEnabled: boolean;
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function scoreClass(score: number) {
  return score >= 8 ? "text-emerald-400" : score >= 5 ? "text-amber-300" : "text-rose-400";
}

const isRunning = (r: PullReview | null) => r?.status === "pending" || r?.status === "in_progress";

/**
 * Open pull requests of one granted repository with their CodeGuard review
 * state, shown on the dashboard after a repo is picked from the drawer.
 */
export default function RepoPulls({ fullName, onClose }: { fullName: string; onClose: () => void }) {
  const [owner, name] = fullName.split("/");
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [starting, setStarting] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});
  const abort = useRef<AbortController | null>(null);

  const base = `/api/github/app/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${base}?page=1`, { cache: "no-store" })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || "Failed to load pull requests");
        if (cancelled) return;
        setRepo(json.repo);
        setPulls(json.pulls ?? []);
        setPage(1);
        setHasMore(!!json.hasMore);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load pull requests"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [base, version]);

  // Reviews started elsewhere (auto-review, another tab) — re-check until they finish.
  const othersRunning = starting === null && pulls.some((p) => isRunning(p.review));
  useEffect(() => {
    if (!othersRunning) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") setVersion((v) => v + 1);
    }, 8_000);
    return () => clearInterval(t);
  }, [othersRunning]);

  // Stop any review polling when leaving this repo.
  useEffect(() => () => abort.current?.abort(), [fullName]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`${base}?page=${page + 1}`, { cache: "no-store" });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || "Failed to load pull requests");
      setPulls((prev) => [...prev, ...(json.pulls ?? [])]);
      setPage((p) => p + 1);
      setHasMore(!!json.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load pull requests");
    } finally {
      setLoadingMore(false);
    }
  };

  const setReview = (number: number, review: PullReview) =>
    setPulls((prev) => prev.map((p) => (p.number === number ? { ...p, review } : p)));

  const runReview = async (pr: Pull) => {
    if (starting !== null || isRunning(pr.review)) return;
    setStarting(pr.number);
    setRowError((s) => {
      const next = { ...s };
      delete next[pr.number];
      return next;
    });
    try {
      const res = await fetch("/api/github/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo: name, pullNumber: pr.number }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the review");
      setReview(pr.number, { id: data.id, status: "in_progress", score: null, createdAt: new Date().toISOString(), outdated: false });

      abort.current ??= new AbortController();
      const done = await pollReview(data.id, { signal: abort.current.signal });
      setReview(pr.number, { id: done.id, status: "completed", score: done.score, createdAt: done.createdAt, outdated: false });
    } catch (e) {
      if (abort.current?.signal.aborted) return;
      setRowError((s) => ({ ...s, [pr.number]: e instanceof Error ? e.message : "Review failed" }));
      setVersion((v) => v + 1);
    } finally {
      setStarting(null);
    }
  };

  const reviewed = pulls.filter((p) => p.review?.status === "completed" && !p.review.outdated).length;

  return (
    <section className="rounded-md border border-cg-border">
      <div className="px-4 pt-3.5 pb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-cg-text flex items-center gap-1.5 truncate">
            <span className="text-cg-muted">{owner}/</span>
            {name}
            {repo?.private && <Lock size={12} className="text-cg-subtle shrink-0" />}
            {repo?.htmlUrl && (
              <a href={repo.htmlUrl} target="_blank" rel="noreferrer" aria-label="Open on GitHub" className="text-cg-subtle hover:text-cg-text">
                <ArrowSquareOut size={13} />
              </a>
            )}
          </h2>
          <p className="text-xs text-cg-subtle mt-0.5">
            {loading ? "Open pull requests" : `${pulls.length}${hasMore ? "+" : ""} open · ${reviewed} reviewed`}
            {repo?.autoReviewEnabled && <span className="text-emerald-400"> · Auto-review on</span>}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setVersion((v) => v + 1)}
            disabled={loading}
            aria-label="Refresh"
            className="h-7 w-7 flex items-center justify-center rounded text-cg-subtle hover:text-cg-text hover:bg-cg-raised transition disabled:opacity-50"
          >
            <ArrowClockwise size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close repository"
            className="h-7 w-7 flex items-center justify-center rounded text-cg-subtle hover:text-cg-text hover:bg-cg-raised transition"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="px-2 pb-2">
        {loading && pulls.length === 0 ? (
          <div className="py-6 flex justify-center">
            <PixelLoader label="Loading pull requests" />
          </div>
        ) : error ? (
          <p className="py-6 text-center text-sm text-rose-400">{error}</p>
        ) : pulls.length === 0 ? (
          <div className="py-6 flex items-center justify-center gap-2.5 text-sm text-cg-subtle">
            <GitPullRequest size={18} />
            No open pull requests.
          </div>
        ) : (
          <ul className="flex flex-col">
            {pulls.map((pr) => (
              <li key={pr.number} className="flex items-center gap-3 px-2 py-2.5 rounded hover:bg-cg-raised/60 transition-colors">
                <GitPullRequest size={16} className="text-cg-subtle shrink-0" />
                <div className="min-w-0 flex-1">
                  <a href={pr.htmlUrl} target="_blank" rel="noreferrer" className="text-sm text-cg-text truncate block hover:underline">
                    <span className="text-cg-subtle">#{pr.number}</span> {pr.title}
                  </a>
                  <p className="text-xs text-cg-subtle mt-0.5 truncate">
                    {pr.authorLogin} · {pr.headBranch} → {pr.baseBranch} · {timeAgo(pr.createdAt)}
                    {rowError[pr.number] && <span className="text-rose-400"> · {rowError[pr.number]}</span>}
                  </p>
                </div>
                <ReviewState pr={pr} busy={starting === pr.number} disabled={starting !== null} onReview={() => runReview(pr)} />
              </li>
            ))}
          </ul>
        )}
        {!loading && hasMore && (
          <div className="flex justify-end px-2 pt-2">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="h-7 px-2.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition disabled:pointer-events-none"
            >
              {loadingMore ? <PixelLoader className="!text-xs" /> : "Load more"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewState({ pr, busy, disabled, onReview }: { pr: Pull; busy: boolean; disabled: boolean; onReview: () => void }) {
  const r = pr.review;
  const button = (label: string) => (
    <button
      onClick={onReview}
      disabled={disabled}
      className="h-7 px-2.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition disabled:opacity-50 disabled:pointer-events-none shrink-0"
    >
      {label}
    </button>
  );

  if (busy && !r) return <PixelLoader label="Starting" className="!text-xs" />;
  if (isRunning(r)) return <PixelLoader label="Reviewing" className="!text-xs" />;
  if (!r) return button("Review");
  if (r.status === "failed") {
    return (
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-rose-400">Failed</span>
        {button("Retry")}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 shrink-0">
      {r.outdated && (
        <span className="px-1.5 py-px rounded bg-amber-400/10 text-[11px] text-amber-300" title="New commits since the last review">
          New commits
        </span>
      )}
      <Link
        href={`/reviews/${r.id}`}
        className="h-7 px-2 flex items-center gap-1.5 rounded hover:bg-cg-raised transition"
        title={`Reviewed ${timeAgo(r.createdAt)}`}
      >
        {r.score !== null && <span className={`text-sm font-medium tabular-nums ${scoreClass(r.score)}`}>{r.score.toFixed(1)}</span>}
        <span className="text-xs text-cg-subtle">View</span>
      </Link>
      {r.outdated && button("Re-review")}
    </div>
  );
}
