"use client";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useUser, SignInButton } from "@clerk/nextjs";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import {
  ArrowClockwise,
  ArrowRight,
  Bug,
  CaretRight,
  CheckCircle,
  GitPullRequest,
  GithubLogo,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  Star,
  Trash,
  Warning,
  WarningOctagon,
  XCircle,
  ArrowsClockwise,
  X,
} from "@phosphor-icons/react";
import PRReviewer from "./PRReviewer";
import PixelLoader, { PixelLoaderBlock } from "./ui/PixelLoader";
import { NEW_REVIEW_EVENT } from "@/lib/events";
import { PageSkeleton } from "./ui/PixelSkeleton";

type Severity = "critical" | "high" | "medium" | "low";
type Group = "attention" | "working" | "completed" | "failed";

interface ReviewRow {
  id: string;
  title: string | null;
  score: number | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt: string;
  issues: { severity: Severity; category: string }[];
}

interface TrendsData {
  scoreTrend: Array<{ date: string; avgScore: number; count: number }>;
  categoryBreakdown: Array<{ category: string; severity: string; count: number }>;
}

const RANGE_DAYS = 30;
const GROUP_PAGE_SIZE = 10;

const GROUPS: { id: Group; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; tone: string; empty: string }[] = [
  { id: "attention", label: "Needs attention", icon: Warning, tone: "text-amber-400", empty: "No reviews need attention." },
  { id: "working", label: "Working", icon: ArrowsClockwise, tone: "text-orange-400", empty: "No reviews in progress." },
  { id: "completed", label: "Completed", icon: CheckCircle, tone: "text-emerald-400", empty: "No completed reviews yet." },
  { id: "failed", label: "Failed", icon: XCircle, tone: "text-rose-400", empty: "No failed reviews." },
];

const SEVERITY_META: Record<Severity, { label: string; bar: string }> = {
  critical: { label: "Critical", bar: "bg-rose-500" },
  high: { label: "High", bar: "bg-orange-400" },
  medium: { label: "Medium", bar: "bg-amber-300" },
  low: { label: "Low", bar: "bg-sky-400" },
};

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function scoreClass(score: number) {
  return score >= 8 ? "text-emerald-400" : score >= 5 ? "text-amber-300" : "text-rose-400";
}

/** One point per day for the range, so gaps render as zero instead of being skipped. */
function dailySeries(trend: TrendsData["scoreTrend"]) {
  const byDate = new Map(trend.map((p) => [p.date.slice(0, 10), p.count]));
  const out: { day: string; reviews: number }[] = [];
  for (let i = RANGE_DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({
      day: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      reviews: byDate.get(d.toISOString().slice(0, 10)) ?? 0,
    });
  }
  return out;
}

export default function ReviewerDashboard() {
  const { isSignedIn, isLoaded } = useUser();
  const [trends, setTrends] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  // Opened from the sidebar / command palette via /?new=1 or NEW_REVIEW_EVENT.
  const [showReviewer, setShowReviewer] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("new")
  );

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("new")) window.history.replaceState(null, "", "/");
    const open = () => {
      setShowReviewer(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener(NEW_REVIEW_EVENT, open);
    return () => window.removeEventListener(NEW_REVIEW_EVENT, open);
  }, []);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  const refresh = () => {
    setLoading(true);
    setVersion((v) => v + 1);
  };

  // Debounce the search box into the query the groups fetch with.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetch(`/api/reviews/trends?days=${RANGE_DAYS}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled) setTrends(json);
      })
      .catch((e) => console.error("Failed to load dashboard:", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, version]);

  const stats = useMemo(() => {
    const trend = trends?.scoreTrend ?? [];
    const reviews = trend.reduce((a, p) => a + p.count, 0);
    const weighted = trend.reduce((a, p) => a + p.avgScore * p.count, 0);
    const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const b of trends?.categoryBreakdown ?? []) {
      if (b.severity in bySeverity) bySeverity[b.severity as Severity] += b.count;
    }
    const issues = Object.values(bySeverity).reduce((a, n) => a + n, 0);
    return {
      reviews,
      avgScore: reviews > 0 ? weighted / reviews : null,
      issues,
      blocking: bySeverity.critical + bySeverity.high,
      bySeverity,
      series: dailySeries(trend),
    };
  }, [trends]);

  if (!isLoaded) return <PixelLoaderBlock className="min-h-[70vh]" />;
  if (!isSignedIn) return <SignedOutState />;
  // First load only — later refreshes keep the page on screen.
  if (loading && !trends) return <PageSkeleton filters={4} rows={6} cols={4} />;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 md:px-6 pt-4 pb-10 flex flex-col gap-5">
      {/* Title row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-cg-text">PR reviews</h1>
          <p className="text-sm text-cg-subtle">Last {RANGE_DAYS} days across your repositories.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh"
            className="h-8 w-8 flex items-center justify-center rounded border border-cg-border text-cg-muted hover:text-cg-text hover:bg-cg-raised transition disabled:opacity-50"
          >
            <ArrowClockwise size={15} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            onClick={() => setShowReviewer((v) => !v)}
            className="h-8 px-3 flex items-center gap-1.5 rounded border border-cg-border bg-cg-raised text-sm text-cg-text hover:bg-cg-border/60 transition"
          >
            {showReviewer ? <X size={14} /> : <Plus size={14} />}
            {showReviewer ? "Close" : "New review"}
          </button>
        </div>
      </div>

      {showReviewer && (
        <section className="rounded-md border border-cg-border p-5">
          <PRReviewer />
        </section>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px rounded-md overflow-hidden border border-cg-border bg-cg-border">
        <Kpi icon={GitPullRequest} label="PRs reviewed" value={stats.reviews.toLocaleString()} />
        <Kpi
          icon={Star}
          label="Avg. quality score"
          value={stats.avgScore === null ? "—" : stats.avgScore.toFixed(1)}
          suffix={stats.avgScore === null ? undefined : "/ 10"}
        />
        <Kpi icon={Bug} label="Issues found" value={stats.issues.toLocaleString()} />
        <Kpi icon={WarningOctagon} label="Critical & high" value={stats.blocking.toLocaleString()} />
      </div>

      {/* Activity + severity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel title="Review activity" className="lg:col-span-2">
          <div className="h-44 -mx-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.series} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffa057" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#ffa057" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="day"
                  stroke="#71717a"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <Tooltip
                  cursor={{ stroke: "#3f3f46" }}
                  contentStyle={{ background: "#232127", border: "1px solid #38353d", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "#a1a1aa" }}
                  itemStyle={{ color: "#fafafa" }}
                  formatter={(v: number) => [v, "Reviews"]}
                />
                <Area type="monotone" dataKey="reviews" stroke="#ffa057" strokeWidth={1.75} fill="url(#activityFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Issues by severity">
          {stats.issues === 0 ? (
            <div className="h-44 flex flex-col items-center justify-center gap-2 text-center">
              <ShieldCheck size={24} className="text-emerald-400" />
              <p className="text-sm text-cg-subtle">No issues found yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3.5">
              {(Object.keys(SEVERITY_META) as Severity[]).map((s) => {
                const n = stats.bySeverity[s];
                return (
                  <div key={s} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-cg-muted">{SEVERITY_META[s].label}</span>
                      <span className="text-cg-subtle tabular-nums">{n}</span>
                    </div>
                    <div className="h-1 rounded-full bg-cg-raised overflow-hidden">
                      <div
                        className={`h-full rounded-full ${SEVERITY_META[s].bar}`}
                        style={{ width: `${(n / stats.issues) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <MagnifyingGlass size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search review titles..."
            className="w-full h-8 pl-8 pr-3 rounded border border-cg-border bg-transparent text-sm text-cg-text placeholder:text-cg-subtle focus:outline-none focus:border-cg-muted"
          />
        </div>
        {search && (
          <button
            onClick={() => setSearch("")}
            className="h-8 px-2 flex items-center gap-1.5 text-sm text-cg-subtle hover:text-cg-text transition"
          >
            <Trash size={14} />
            Clear filters
          </button>
        )}
      </div>

      {/* Status groups — each pages independently. Keyed so a new search/refresh starts fresh. */}
      <div className="flex flex-col gap-3">
        {GROUPS.map((g, i) => (
          <ReviewGroup key={`${g.id}:${query}:${version}`} group={g} query={query} defaultOpen={i === 0 || i === 2} />
        ))}
      </div>
    </div>
  );
}

function ReviewGroup({
  group,
  query,
  defaultOpen,
}: {
  group: (typeof GROUPS)[number];
  query: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [items, setItems] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = (p: number) =>
    `/api/reviews?group=${group.id}&page=${p}&pageSize=${GROUP_PAGE_SIZE}${query ? `&q=${encodeURIComponent(query)}` : ""}`;

  useEffect(() => {
    let cancelled = false;
    fetch(url(1))
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || "Failed to load reviews");
        if (cancelled) return;
        setItems(json.reviews ?? []);
        setTotal(json.total ?? 0);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load reviews");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // url() only depends on props that are part of this component's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = page + 1;
      const r = await fetch(url(next));
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || "Failed to load reviews");
      setItems((prev) => [...prev, ...(json.reviews ?? [])]);
      setTotal(json.total ?? 0);
      setPage(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load reviews");
    } finally {
      setLoadingMore(false);
    }
  };

  const Icon = group.icon;

  return (
    <section className="rounded-md border border-cg-border">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full h-12 px-4 flex items-center gap-2.5 text-left"
      >
        <CaretRight size={13} className={`text-cg-subtle transition-transform ${open ? "rotate-90" : ""}`} />
        <Icon size={16} className={group.tone} />
        <span className="text-sm font-medium text-cg-text">{group.label}</span>
        <span className="min-w-5 h-5 px-1.5 rounded bg-cg-raised text-xs text-cg-muted flex items-center justify-center tabular-nums">
          {loading ? "–" : total}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2">
          {loading ? (
            <div className="py-6 flex justify-center">
              <PixelLoader />
            </div>
          ) : error ? (
            <p className="py-6 text-center text-sm text-rose-400">{error}</p>
          ) : items.length === 0 ? (
            <div className="py-6 flex items-center justify-center gap-2.5 text-sm text-cg-subtle">
              <GitPullRequest size={18} />
              {query ? "No matching reviews." : group.empty}
            </div>
          ) : (
            <>
              <ul className="flex flex-col">
                {items.map((r) => (
                  <ReviewItem key={r.id} review={r} />
                ))}
              </ul>
              {items.length < total && (
                <div className="flex items-center justify-between px-2 pt-2 text-xs text-cg-subtle">
                  <span className="tabular-nums">
                    Showing {items.length} of {total}
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
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ReviewItem({ review: r }: { review: ReviewRow }) {
  const major = r.issues.filter((i) => i.severity === "critical" || i.severity === "high").length;
  return (
    <li>
      <Link
        href={`/reviews/${r.id}`}
        className="flex items-center gap-3 px-2 py-2.5 rounded hover:bg-cg-raised transition-colors group"
      >
        <GitPullRequest size={16} className="text-cg-subtle shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-cg-text truncate">{r.title || "Untitled review"}</p>
          <p className="text-xs text-cg-subtle mt-0.5">
            {timeAgo(r.createdAt)} · {r.issues.length} {r.issues.length === 1 ? "issue" : "issues"}
            {major > 0 && <span className="text-rose-400"> · {major} major</span>}
          </p>
        </div>
        {r.status === "pending" || r.status === "in_progress" ? (
          <PixelLoader label={r.status === "pending" ? "Queued" : "Reviewing"} className="!text-xs" />
        ) : r.score !== null ? (
          <span className={`text-sm font-medium tabular-nums ${scoreClass(r.score)}`}>{r.score.toFixed(1)}</span>
        ) : null}
        <ArrowRight size={14} className="text-cg-subtle opacity-0 group-hover:opacity-100 transition-opacity" />
      </Link>
    </li>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  suffix,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="p-4 flex flex-col gap-2.5 bg-cg-panel">
      <div className="flex items-center gap-2 text-cg-subtle">
        <Icon size={14} />
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-2xl font-semibold text-cg-text tabular-nums">
        {value}
        {suffix && <span className="text-sm font-normal text-cg-subtle ml-1">{suffix}</span>}
      </p>
    </div>
  );
}

function Panel({ title, className = "", children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-md border border-cg-border ${className}`}>
      <h2 className="px-4 pt-3.5 pb-3 text-sm font-medium text-cg-text">{title}</h2>
      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}

function SignedOutState() {
  return (
    <div className="min-h-[75vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center flex flex-col items-center gap-5">
        <span className="h-11 w-11 rounded-full bg-cg-text text-cg-bg flex items-center justify-center">
          <ShieldCheck size={22} weight="fill" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-cg-text">AI code reviews for every pull request</h1>
          <p className="text-sm text-cg-muted mt-2 leading-relaxed">
            CodeGuard reviews your diffs, catches bugs and security issues, and posts inline comments on GitHub.
          </p>
        </div>
        <SignInButton mode="modal">
          <button className="h-9 px-4 flex items-center gap-2 rounded bg-cg-text text-cg-bg text-sm font-medium hover:opacity-90 transition">
            <GithubLogo size={16} weight="fill" />
            Sign in with GitHub
          </button>
        </SignInButton>
      </div>
    </div>
  );
}
