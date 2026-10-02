"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowSquareOut,
  CaretDown,
  Check,
  CheckCircle,
  Copy,
  FileCode,
  GitBranch,
  GitCommit,
  GitPullRequest,
  GithubLogo,
  Lightbulb,
  LinkSimple,
  Robot,
  ShieldCheck,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import PixelLoader, { PixelLoaderBlock } from "@/components/ui/PixelLoader";

type Severity = "critical" | "high" | "medium" | "low";

interface Issue {
  id?: string;
  severity: string;
  category: string;
  file: string | null;
  line: number | null;
  message: string;
  suggestion: string | null;
}

interface ReviewDetail {
  id: string;
  title: string | null;
  codeSnippet: string | null;
  language: string | null;
  score: number | null;
  summary: string | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  reviewType: string;
  model: string | null;
  headSha: string | null;
  createdAt: string;
  issues: Issue[];
  repo: string | null;
  prNumber: number | null;
  pullRequest: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    htmlUrl: string;
    headBranch: string;
    baseBranch: string;
    authorLogin: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
  } | null;
  details: { tokens: number | null; durationMs: number | null; githubUrl: string | null } | null;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SEVERITY_META: Record<Severity, { label: string; dot: string; pill: string; ring: string }> = {
  critical: { label: "Critical", dot: "bg-rose-500", pill: "bg-rose-500/10 text-rose-400 border-rose-500/25", ring: "border-l-rose-500" },
  high: { label: "High", dot: "bg-orange-400", pill: "bg-orange-400/10 text-orange-300 border-orange-400/25", ring: "border-l-orange-400" },
  medium: { label: "Medium", dot: "bg-amber-300", pill: "bg-amber-300/10 text-amber-200 border-amber-300/25", ring: "border-l-amber-300" },
  low: { label: "Low", dot: "bg-sky-400", pill: "bg-sky-400/10 text-sky-300 border-sky-400/25", ring: "border-l-sky-400" },
};

const metaFor = (s: string) => SEVERITY_META[(s in SEVERITY_META ? s : "low") as Severity];
const NO_FILE = "General";

function scoreTone(score: number) {
  return score >= 8 ? "text-emerald-400" : score >= 5 ? "text-amber-300" : "text-rose-400";
}

function verdict(review: ReviewDetail, blocking: number) {
  if (blocking > 0) return { text: `${blocking} blocking ${blocking === 1 ? "issue" : "issues"} to fix before merging`, tone: "text-rose-400", Icon: XCircle };
  if ((review.score ?? 0) >= 8) return { text: "Looks good to merge", tone: "text-emerald-400", Icon: CheckCircle };
  if (review.issues.length === 0) return { text: "No issues found", tone: "text-emerald-400", Icon: CheckCircle };
  return { text: "Worth a look before merging", tone: "text-amber-300", Icon: WarningCircle };
}

/** Split an AI suggestion into prose and ``` fenced code blocks. */
function splitFences(text: string): { code: boolean; body: string }[] {
  const parts: { code: boolean; body: string }[] = [];
  const re = /```[\w+-]*\n?([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ code: false, body: text.slice(last, m.index).trim() });
    parts.push({ code: true, body: m[1].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, body: text.slice(last).trim() });
  const out = parts.filter((p) => p.body);
  // A bare multi-line suggestion is almost always code.
  if (out.length === 1 && !out[0].code && out[0].body.includes("\n")) out[0].code = true;
  return out;
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

export default function ReviewDetailPage() {
  const params = useParams();
  const reviewId = params?.id as string;

  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(`/api/reviews/${reviewId}`, { cache: "no-store", signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not load the review");
    return data.review as ReviewDetail;
  }, [reviewId]);

  useEffect(() => {
    if (!reviewId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await load(controller.signal);
        setReview(r);
        // Still running → check again (while the tab is visible).
        if (r.status === "pending" || r.status === "in_progress") {
          timer = setTimeout(function wait() {
            if (document.visibilityState === "visible") void tick();
            else timer = setTimeout(wait, 3000);
          }, 3000);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the review");
      }
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reviewId, load]);

  if (error) return <CenteredState icon={<WarningCircle size={26} className="text-rose-400" />} title="Review not found" body={error} />;
  if (!review) return <PixelLoaderBlock label="Loading review" className="min-h-[70vh]" />;
  if (review.status === "pending" || review.status === "in_progress") {
    return (
      <CenteredState
        icon={<PixelLoader label={review.status === "pending" ? "Queued" : "Reviewing"} />}
        title={review.title || "Review in progress"}
        body="CodeGuard is reading the changes. This page updates on its own when the review is done."
      />
    );
  }
  if (review.status === "failed") {
    return (
      <CenteredState
        icon={<XCircle size={26} className="text-rose-400" />}
        title="This review failed"
        body="Something went wrong while reviewing these changes. Start a new review of the pull request to try again."
        extra={
          review.pullRequest && (
            <a
              href={review.pullRequest.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-cg-muted hover:text-cg-text inline-flex items-center gap-1"
            >
              {review.repo} #{review.pullRequest.number} <ArrowSquareOut size={12} />
            </a>
          )
        }
      />
    );
  }
  return <ReviewReport review={review} onUpdate={setReview} />;
}

function ReviewReport({ review, onUpdate }: { review: ReviewDetail; onUpdate: (r: ReviewDetail) => void }) {
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [category, setCategory] = useState<string>("all");
  const [linkCopied, setLinkCopied] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const pr = review.pullRequest;
  const score = review.score ?? 0;

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const i of review.issues) c[(i.severity in c ? i.severity : "low") as Severity]++;
    return c;
  }, [review.issues]);
  const blocking = counts.critical + counts.high;
  const categories = useMemo(() => Array.from(new Set(review.issues.map((i) => i.category))).sort(), [review.issues]);

  // Filtered issues grouped by file; files with the worst issues first.
  const groups = useMemo(() => {
    const visible = review.issues
      .filter((i) => (severity === "all" || i.severity === severity) && (category === "all" || i.category === category))
      .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || (a.line ?? 0) - (b.line ?? 0));
    const byFile = new Map<string, Issue[]>();
    for (const i of visible) {
      const k = i.file ?? NO_FILE;
      byFile.set(k, [...(byFile.get(k) ?? []), i]);
    }
    return [...byFile.entries()].sort(
      ([, a], [, b]) => (SEVERITY_RANK[a[0].severity] ?? 9) - (SEVERITY_RANK[b[0].severity] ?? 9) || b.length - a.length
    );
  }, [review.issues, severity, category]);
  const shown = groups.reduce((n, [, list]) => n + list.length, 0);

  const fileUrl = (file: string, line: number | null) =>
    pr && review.headSha && file !== NO_FILE
      ? `https://github.com/${pr.owner}/${pr.repo}/blob/${review.headSha}/${file.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`
      : null;

  const copyLink = () => {
    void navigator.clipboard.writeText(window.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1800);
  };

  const postToGitHub = async () => {
    if (posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch("/api/github/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId: review.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not post to GitHub");
      onUpdate({ ...review, details: { tokens: review.details?.tokens ?? null, durationMs: review.details?.durationMs ?? null, githubUrl: data.htmlUrl ?? pr?.htmlUrl ?? null } });
    } catch (e) {
      setPostError(e instanceof Error ? e.message : "Could not post to GitHub");
    } finally {
      setPosting(false);
    }
  };

  const v = verdict(review, blocking);

  return (
    <div className="w-full max-w-6xl mx-auto px-4 md:px-6 pt-4 pb-12 flex flex-col gap-5">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <Link href="/reviews/trends" className="inline-flex items-center gap-1.5 text-sm text-cg-muted hover:text-cg-text transition">
          <ArrowLeft size={14} />
          Reports
        </Link>
        <div className="flex items-center gap-1.5">
          <button
            onClick={copyLink}
            className="h-8 px-2.5 flex items-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition"
          >
            {linkCopied ? <Check size={13} /> : <LinkSimple size={13} />}
            {linkCopied ? "Copied" : "Copy link"}
          </button>
          {pr &&
            (review.details?.githubUrl ? (
              <a
                href={review.details.githubUrl}
                target="_blank"
                rel="noreferrer"
                className="h-8 px-2.5 flex items-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition"
              >
                <GithubLogo size={13} />
                View on GitHub
              </a>
            ) : (
              <button
                onClick={postToGitHub}
                disabled={posting}
                className="h-8 px-3 flex items-center gap-1.5 rounded bg-cg-text text-cg-bg text-xs font-medium hover:opacity-90 transition disabled:opacity-60"
              >
                <GithubLogo size={13} weight="fill" />
                {posting ? "Posting…" : "Post review to GitHub"}
              </button>
            ))}
        </div>
      </div>
      {postError && <p className="text-xs text-rose-400 -mt-3 text-right">{postError}</p>}

      {/* Header */}
      <header className="rounded-md border border-cg-border p-5 flex flex-col md:flex-row gap-5 md:items-center">
        <div className="min-w-0 flex-1 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-cg-subtle flex-wrap">
            {pr ? (
              <a href={pr.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-cg-text">
                <GitPullRequest size={13} />
                {review.repo} <span className="text-cg-muted">#{pr.number}</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <FileCode size={13} />
                Code snippet{review.language ? ` · ${review.language}` : ""}
              </span>
            )}
            {review.reviewType === "automated" && (
              <span className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-cg-raised text-cg-muted">
                <Robot size={11} /> Auto-review
              </span>
            )}
          </div>
          <h1 className="text-lg font-semibold text-cg-text leading-snug">{pr?.title || review.title || "Code review"}</h1>
          {pr && (
            <p className="text-xs text-cg-subtle flex items-center gap-1.5 flex-wrap">
              {pr.authorLogin && <span className="text-cg-muted">{pr.authorLogin}</span>}
              <span className="inline-flex items-center gap-1 font-mono">
                <GitBranch size={12} />
                {pr.headBranch} → {pr.baseBranch}
              </span>
            </p>
          )}
          <p className={`text-sm flex items-center gap-1.5 mt-1 ${v.tone}`}>
            <v.Icon size={15} weight="fill" />
            {v.text}
          </p>
        </div>
        <ScoreRing score={score} />
      </header>

      {/* Severity tiles — also filters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-md overflow-hidden border border-cg-border bg-cg-border">
        {SEVERITIES.map((s) => {
          const active = severity === s;
          return (
            <button
              key={s}
              onClick={() => setSeverity(active ? "all" : s)}
              aria-pressed={active}
              disabled={counts[s] === 0}
              className={`p-3.5 text-left flex flex-col gap-1.5 transition ${active ? "bg-cg-raised" : "bg-cg-panel hover:bg-cg-raised/60"} disabled:hover:bg-cg-panel disabled:cursor-default`}
            >
              <span className="flex items-center gap-1.5 text-xs text-cg-subtle">
                <span className={`h-2 w-2 rounded-full ${SEVERITY_META[s].dot}`} />
                {SEVERITY_META[s].label}
              </span>
              <span className={`text-xl font-semibold tabular-nums ${counts[s] ? "text-cg-text" : "text-cg-subtle"}`}>{counts[s]}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          {review.summary && (
            <section className="rounded-md border border-cg-border p-4">
              <h2 className="text-sm font-medium text-cg-text mb-2">Summary</h2>
              <p className="text-sm text-cg-muted leading-relaxed whitespace-pre-line">{review.summary}</p>
            </section>
          )}

          {/* Issues */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-medium text-cg-text">
                Issues <span className="text-cg-subtle font-normal tabular-nums">({shown === review.issues.length ? shown : `${shown} of ${review.issues.length}`})</span>
              </h2>
              {categories.length > 1 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {["all", ...categories].map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategory(c)}
                      className={`h-7 px-2.5 rounded text-xs capitalize transition ${category === c ? "bg-cg-raised text-cg-text" : "text-cg-subtle hover:text-cg-text"}`}
                    >
                      {c === "all" ? "All" : c.replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {review.issues.length === 0 ? (
              <div className="rounded-md border border-cg-border py-10 flex flex-col items-center gap-2 text-center">
                <ShieldCheck size={26} className="text-emerald-400" />
                <p className="text-sm text-cg-text">No issues found</p>
                <p className="text-xs text-cg-subtle">CodeGuard didn&apos;t find anything to fix in these changes.</p>
              </div>
            ) : shown === 0 ? (
              <div className="rounded-md border border-cg-border py-8 text-center text-sm text-cg-subtle">
                No issues match these filters.{" "}
                <button onClick={() => { setSeverity("all"); setCategory("all"); }} className="text-cg-text underline underline-offset-2">
                  Clear filters
                </button>
              </div>
            ) : (
              groups.map(([file, list]) => <FileGroup key={file} file={file} issues={list} fileUrl={fileUrl} />)
            )}
          </section>

          {review.codeSnippet && <SnippetView code={review.codeSnippet} issues={review.issues} />}
        </div>

        {/* Details */}
        <aside className="rounded-md border border-cg-border p-4 flex flex-col gap-3 lg:sticky lg:top-16">
          <h2 className="text-sm font-medium text-cg-text">Details</h2>
          <dl className="flex flex-col gap-2.5 text-xs">
            <Detail label="Reviewed">{new Date(review.createdAt).toLocaleString()}</Detail>
            {pr && (
              <Detail label="Changes">
                <span className="text-emerald-400">+{pr.additions}</span> <span className="text-rose-400">−{pr.deletions}</span>
                <span className="text-cg-subtle"> · {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}</span>
              </Detail>
            )}
            {review.headSha && (
              <Detail label="Commit">
                {pr ? (
                  <a
                    href={`https://github.com/${pr.owner}/${pr.repo}/commit/${review.headSha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono inline-flex items-center gap-1 hover:text-cg-text"
                  >
                    <GitCommit size={12} />
                    {review.headSha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="font-mono">{review.headSha.slice(0, 7)}</span>
                )}
              </Detail>
            )}
            <Detail label="Type">{review.reviewType === "automated" ? "Auto-review" : review.reviewType === "paste_code" ? "Snippet" : "Manual"}</Detail>
            {review.model && <Detail label="Model"><span className="font-mono">{review.model}</span></Detail>}
            {review.details?.durationMs != null && <Detail label="Took">{formatDuration(review.details.durationMs)}</Detail>}
            {review.details?.tokens != null && <Detail label="Tokens">{review.details.tokens.toLocaleString()}</Detail>}
            <Detail label="Review ID"><span className="font-mono">{review.id.slice(0, 8)}</span></Detail>
          </dl>
          {pr && (
            <a
              href={pr.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 h-8 flex items-center justify-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition"
            >
              Open pull request <ArrowSquareOut size={12} />
            </a>
          )}
        </aside>
      </div>
    </div>
  );
}

function FileGroup({ file, issues, fileUrl }: { file: string; issues: Issue[]; fileUrl: (file: string, line: number | null) => string | null }) {
  const [open, setOpen] = useState(true);
  const href = fileUrl(file, null);
  return (
    <div className="rounded-md border border-cg-border overflow-hidden">
      <div className="h-10 px-3 flex items-center gap-2 bg-cg-raised/40 border-b border-cg-border">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-2 min-w-0 flex-1 text-left">
          <CaretDown size={12} className={`text-cg-subtle shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <FileCode size={14} className="text-cg-subtle shrink-0" />
          <span className="text-xs font-mono text-cg-text truncate" title={file}>{file}</span>
        </button>
        <span className="text-xs text-cg-subtle tabular-nums shrink-0">{issues.length}</span>
        {href && (
          <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${file} on GitHub`} className="text-cg-subtle hover:text-cg-text shrink-0">
            <ArrowSquareOut size={13} />
          </a>
        )}
      </div>
      {open && (
        <ul className="divide-y divide-cg-border">
          {issues.map((issue, i) => (
            <IssueCard key={issue.id ?? i} issue={issue} href={fileUrl(file, issue.line)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueCard({ issue, href }: { issue: Issue; href: string | null }) {
  const meta = metaFor(issue.severity);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(issue.suggestion ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <li className={`p-4 flex flex-col gap-3 border-l-2 ${meta.ring}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-1.5 py-px rounded border text-[11px] font-medium ${meta.pill}`}>{meta.label}</span>
        <span className="px-1.5 py-px rounded bg-cg-raised text-[11px] text-cg-muted capitalize">{issue.category.replace(/_/g, " ")}</span>
        {issue.line != null &&
          (href ? (
            <a href={href} target="_blank" rel="noreferrer" className="ml-auto text-[11px] font-mono text-cg-subtle hover:text-cg-text inline-flex items-center gap-1">
              Line {issue.line} <ArrowSquareOut size={11} />
            </a>
          ) : (
            <span className="ml-auto text-[11px] font-mono text-cg-subtle">Line {issue.line}</span>
          ))}
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-wider text-cg-subtle mb-1">What&apos;s wrong</p>
        <p className="text-sm text-cg-text leading-relaxed whitespace-pre-line">{issue.message}</p>
      </div>

      {issue.suggestion && (
        <div className="rounded border border-emerald-500/20 bg-emerald-500/[0.04]">
          <div className="h-8 px-3 flex items-center justify-between border-b border-emerald-500/15">
            <span className="text-[11px] uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <Lightbulb size={12} weight="fill" />
              How to fix
            </span>
            <button onClick={copy} className="text-[11px] text-cg-muted hover:text-cg-text inline-flex items-center gap-1">
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="p-3 flex flex-col gap-2">
            {splitFences(issue.suggestion).map((part, i) =>
              part.code ? (
                <pre key={i} className="text-xs font-mono text-cg-text bg-cg-bg/70 rounded p-3 overflow-x-auto leading-relaxed">
                  {part.body}
                </pre>
              ) : (
                <p key={i} className="text-sm text-cg-muted leading-relaxed whitespace-pre-line">{part.body}</p>
              )
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** Submitted snippet with line numbers; lines that have issues are marked. */
function SnippetView({ code, issues }: { code: string; issues: Issue[] }) {
  const [open, setOpen] = useState(false);
  const worst = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of issues) {
      if (i.line == null) continue;
      const cur = m.get(i.line);
      if (!cur || (SEVERITY_RANK[i.severity] ?? 9) < (SEVERITY_RANK[cur] ?? 9)) m.set(i.line, i.severity);
    }
    return m;
  }, [issues]);
  const lines = code.split("\n");
  return (
    <section className="rounded-md border border-cg-border overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full h-10 px-4 flex items-center gap-2 text-left">
        <CaretDown size={12} className={`text-cg-subtle transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="text-sm font-medium text-cg-text">Submitted code</span>
        <span className="text-xs text-cg-subtle tabular-nums">{lines.length} lines</span>
      </button>
      {open && (
        <div className="border-t border-cg-border overflow-x-auto max-h-[480px] bg-cg-bg/50">
          <table className="text-xs font-mono leading-relaxed border-collapse w-full">
            <tbody>
              {lines.map((l, i) => {
                const sev = worst.get(i + 1);
                return (
                  <tr key={i} className={sev ? "bg-rose-500/[0.06]" : ""}>
                    <td className={`select-none text-right pr-3 pl-3 text-cg-subtle border-l-2 ${sev ? metaFor(sev).ring : "border-l-transparent"}`}>{i + 1}</td>
                    <td className="pr-4 whitespace-pre text-cg-text">{l || " "}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ScoreRing({ score }: { score: number }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, score / 10));
  return (
    <div className="flex items-center gap-3 shrink-0">
      <svg width="76" height="76" viewBox="0 0 76 76" className={scoreTone(score)} aria-hidden>
        <circle cx="38" cy="38" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="6" />
        <circle
          cx="38"
          cy="38"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform="rotate(-90 38 38)"
        />
        <text x="38" y="43" textAnchor="middle" className="fill-current text-[17px] font-semibold tabular-nums">
          {score.toFixed(1)}
        </text>
      </svg>
      <div className="text-xs text-cg-subtle leading-tight">
        Quality
        <br />
        score <span className="text-cg-muted">/ 10</span>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-cg-subtle shrink-0">{label}</dt>
      <dd className="text-cg-muted text-right min-w-0 break-words">{children}</dd>
    </div>
  );
}

function CenteredState({ icon, title, body, extra }: { icon: React.ReactNode; title: string; body: string; extra?: React.ReactNode }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-md border border-cg-border p-8 flex flex-col items-center gap-3 text-center">
        {icon}
        <h1 className="text-base font-semibold text-cg-text">{title}</h1>
        <p className="text-sm text-cg-muted leading-relaxed">{body}</p>
        {extra}
        <Link href="/reviews/trends" className="mt-2 h-8 px-3 inline-flex items-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition">
          <ArrowLeft size={13} />
          Back to Reports
        </Link>
      </div>
    </div>
  );
}
