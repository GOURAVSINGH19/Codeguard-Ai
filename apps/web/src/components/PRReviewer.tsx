"use client";

import React, { useState, useEffect, useMemo } from "react";
import { pollReview } from "@/lib/poll-review";
import Link from "next/link";
import { SeverityBadge, CategoryBadge, ScoreDisplay, SeverityCountBar } from "./ui/SeverityBadge";

interface Repo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
}

interface PullRequestItem {
  id: number;
  number: number;
  title: string;
  body: string | null;
  authorLogin: string;
  authorAvatar: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  htmlUrl: string;
  createdAt: string;
}

interface Issue {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "bug" | "performance" | "maintainability" | "style";
  file: string | null;
  line: number | null;
  message: string;
  suggestion: string | null;
}

interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

interface PRReviewResult {
  id: string;
  prNumber: number;
  title: string;
  score: number;
  summary: string;
  issues: Issue[];
  changedFiles: ChangedFile[];
  headSha: string;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function PRReviewer() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoSearch, setRepoSearch] = useState<string>("");
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [pulls, setPulls] = useState<PullRequestItem[]>([]);
  const [selectedPR, setSelectedPR] = useState<PullRequestItem | null>(null);

  const [loadingRepos, setLoadingRepos] = useState<boolean>(true);
  const [loadingPulls, setLoadingPulls] = useState<boolean>(false);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [postingComment, setPostingComment] = useState<boolean>(false);

  const [reviewResult, setReviewResult] = useState<PRReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [githubSuccessUrl, setGithubSuccessUrl] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("all");

  const [reposVersion, setReposVersion] = useState(0);
  const fetchRepos = () => {
    setLoadingRepos(true);
    setError(null);
    setReposVersion((v) => v + 1);
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/github/repos")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to fetch repositories");
        if (!cancelled) setRepos(data.repos || []);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, "Failed to load repositories"));
      })
      .finally(() => {
        if (!cancelled) setLoadingRepos(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reposVersion]);

  const fetchPulls = async (repo: Repo) => {
    setSelectedRepo(repo);
    setSelectedPR(null);
    setReviewResult(null);
    setGithubSuccessUrl(null);
    setLoadingPulls(true);
    setError(null);

    try {
      const res = await fetch(`/api/github/repos/${repo.owner}/${repo.name}/pulls`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch pull requests");
      setPulls(data.pulls || []);
    } catch (err) {
      setError(errorMessage(err, "Failed to load pull requests"));
    } finally {
      setLoadingPulls(false);
    }
  };

  const handleRunPRReview = async () => {
    if (!selectedRepo || !selectedPR || analyzing) return;
    setAnalyzing(true);
    setError(null);
    setReviewResult(null);
    setGithubSuccessUrl(null);
    setFilterCategory("all");

    try {
      const res = await fetch("/api/github/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          pullNumber: selectedPR.number,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to analyze PR diff");
      // 202 Accepted: the review runs in the background — poll until done.
      const review = await pollReview(data.id);
      setReviewResult({
        id: review.id,
        prNumber: data.prNumber,
        title: data.title,
        score: review.score ?? 0,
        summary: review.summary ?? "",
        issues: review.issues,
        changedFiles: data.changedFiles,
        headSha: data.headSha,
      });
    } catch (err) {
      setError(errorMessage(err, "Error performing PR review"));
    } finally {
      setAnalyzing(false);
    }
  };

  const handlePostToGitHub = async () => {
    if (!selectedRepo || !selectedPR || !reviewResult || postingComment) return;
    setPostingComment(true);
    setError(null);

    try {
      const res = await fetch("/api/github/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The server posts the stored review — the browser only names it.
        body: JSON.stringify({ reviewId: reviewResult.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to post comment");
      setGithubSuccessUrl(data.htmlUrl || selectedPR.htmlUrl);
    } catch (err) {
      setError(errorMessage(err, "Error posting comment to GitHub"));
    } finally {
      setPostingComment(false);
    }
  };

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  // Filter repos by search
  const filteredRepos = useMemo(
    () =>
      repoSearch.trim()
        ? repos.filter((r) =>
            r.fullName.toLowerCase().includes(repoSearch.toLowerCase())
          )
        : repos,
    [repos, repoSearch]
  );

  const reviewCategories = reviewResult
    ? Array.from(new Set(reviewResult.issues.map((i) => i.category)))
    : [];

  const filteredIssues =
    reviewResult?.issues.filter(
      (i) => filterCategory === "all" || i.category === filterCategory
    ) ?? [];

  return (
    <div className="flex flex-col gap-6 w-full max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          🚀 GitHub Pull Request Reviewer
        </h2>
        <p className="text-xs text-zinc-400">
          Select a repo and open PR → graph-aware diff selection → RAG context → Groq AI analysis → post inline comments
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
          🚨 <strong>Error:</strong> {error}
        </div>
      )}

      {/* Step 1 & 2 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Repo selector */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              Step 1: Repository
              {!loadingRepos && <span className="text-zinc-600 ml-1">({repos.length})</span>}
            </label>
            <button
              onClick={fetchRepos}
              disabled={loadingRepos}
              className="text-[10px] text-zinc-500 hover:text-zinc-300 transition"
            >
              {loadingRepos ? "Loading..." : "↻ Refresh"}
            </button>
          </div>

          {loadingRepos ? (
            <div className="h-9 rounded-lg bg-zinc-800/50 animate-pulse" />
          ) : (
            <>
              {repos.length > 5 && (
                <input
                  type="text"
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  placeholder="Search repositories..."
                  className="bg-zinc-950 text-zinc-200 text-xs rounded-lg px-3 py-2 border border-zinc-800 focus:outline-none focus:border-cyan-500 placeholder:text-zinc-600"
                />
              )}
              <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
                {filteredRepos.length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-3">No repositories found</p>
                ) : (
                  filteredRepos.map((repo) => (
                    <button
                      key={repo.id}
                      onClick={() => fetchPulls(repo)}
                      className={`flex items-center justify-between text-xs px-3 py-2.5 rounded-lg border transition text-left ${
                        selectedRepo?.id === repo.id
                          ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-300"
                          : "bg-zinc-950/50 border-zinc-800 text-zinc-300 hover:border-zinc-600"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="truncate font-mono">{repo.fullName}</span>
                        {repo.private && <span className="text-[10px] text-zinc-500 shrink-0">🔒</span>}
                      </div>
                      {repo.language && (
                        <span className="text-[10px] text-zinc-500 shrink-0 ml-2">{repo.language}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        {/* PR selector */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-3">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Step 2: Open Pull Request
            {!loadingPulls && selectedRepo && <span className="text-zinc-600 ml-1">({pulls.length})</span>}
          </label>

          {!selectedRepo ? (
            <div className="flex-1 flex items-center justify-center text-xs text-zinc-600 py-6">
              ← Select a repository first
            </div>
          ) : loadingPulls ? (
            <div className="flex flex-col gap-1.5">
              {[1,2].map((i) => <div key={i} className="h-12 rounded-lg bg-zinc-800/50 animate-pulse" />)}
            </div>
          ) : pulls.length === 0 ? (
            <div className="text-xs text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 text-center">
              No open PRs in <strong>{selectedRepo.name}</strong>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
              {pulls.map((pr) => (
                <button
                  key={pr.id}
                  onClick={() => { setSelectedPR(pr); setReviewResult(null); setGithubSuccessUrl(null); }}
                  className={`flex flex-col gap-0.5 text-xs px-3 py-2.5 rounded-lg border transition text-left ${
                    selectedPR?.number === pr.number
                      ? "bg-cyan-500/10 border-cyan-500/40"
                      : "bg-zinc-950/50 border-zinc-800 hover:border-zinc-600"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-400 font-bold shrink-0">#{pr.number}</span>
                    <span className="text-zinc-200 truncate">{pr.title}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span>@{pr.authorLogin}</span>
                    <span>·</span>
                    <span className="font-mono">{pr.headBranch} → {pr.baseBranch}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Selected PR + run button */}
      {selectedPR && (
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-cyan-400">PR #{selectedPR.number}</span>
                <span className="text-xs text-zinc-300 font-medium">{selectedPR.title}</span>
              </div>
              <p className="text-[11px] text-zinc-500">
                @{selectedPR.authorLogin} · <span className="font-mono">{selectedPR.headBranch} → {selectedPR.baseBranch}</span>
              </p>
            </div>
          </div>

          <button
            onClick={handleRunPRReview}
            disabled={analyzing}
            className="w-full sm:w-auto py-3 px-6 rounded-xl font-semibold text-xs bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-black hover:opacity-90 transition disabled:opacity-40 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10 shrink-0"
          >
            {analyzing ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                <span>Analyzing diff...</span>
              </>
            ) : (
              <span>⚡ Review PR Diff</span>
            )}
          </button>
        </div>
      )}

      {/* Review result */}
      {reviewResult && (
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-6 shadow-2xl">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 border-b border-zinc-800 pb-5">
            <div className="flex flex-col gap-1 flex-1">
              <h3 className="text-base font-bold text-white">
                PR #{reviewResult.prNumber} — {reviewResult.title}
              </h3>
              <p className="text-xs text-zinc-400">{reviewResult.changedFiles.length} files changed</p>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <div className="w-36">
                <ScoreDisplay score={reviewResult.score} />
              </div>
              <button
                onClick={handlePostToGitHub}
                disabled={postingComment || !!githubSuccessUrl}
                className="py-2.5 px-4 rounded-xl font-semibold text-xs bg-zinc-800 hover:bg-zinc-700 text-white transition border border-zinc-700 flex items-center gap-2 disabled:opacity-50"
              >
                {postingComment ? (
                  <>
                    <div className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Posting...</span>
                  </>
                ) : githubSuccessUrl ? (
                  <span>✓ Posted</span>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span>Post to GitHub</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {githubSuccessUrl && (
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center justify-between">
              <span>🎉 Review posted to GitHub!</span>
              <a href={githubSuccessUrl} target="_blank" rel="noreferrer" className="underline font-bold hover:text-emerald-300">
                View on GitHub ↗
              </a>
            </div>
          )}

          {/* Severity breakdown */}
          <SeverityCountBar issues={reviewResult.issues} />

          {/* Summary */}
          <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
            <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Executive Summary</h4>
            <p className="text-xs text-zinc-300 leading-relaxed">{reviewResult.summary}</p>
          </div>

          {/* Changed files */}
          <div className="flex flex-col gap-2">
            <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
              Changed Files ({reviewResult.changedFiles.length})
            </h4>
            <div className="flex flex-col gap-1 max-h-36 overflow-y-auto">
              {reviewResult.changedFiles.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between bg-zinc-950 px-3 py-2 rounded-lg border border-zinc-800 text-xs font-mono">
                  <span className="text-zinc-300 truncate mr-3">{file.filename}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-emerald-400">+{file.additions}</span>
                    <span className="text-rose-400">-{file.deletions}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Category filter */}
          {reviewCategories.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Filter:</span>
              <button
                onClick={() => setFilterCategory("all")}
                className={`text-[10px] px-2 py-0.5 rounded border transition ${
                  filterCategory === "all"
                    ? "bg-zinc-700 text-white border-zinc-600"
                    : "text-zinc-400 border-zinc-700 hover:text-white"
                }`}
              >
                All ({reviewResult.issues.length})
              </button>
              {reviewCategories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilterCategory(cat)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition capitalize ${
                    filterCategory === cat
                      ? "bg-zinc-700 text-white border-zinc-600"
                      : "text-zinc-400 border-zinc-700 hover:text-white"
                  }`}
                >
                  {cat} ({reviewResult.issues.filter((i) => i.category === cat).length})
                </button>
              ))}
            </div>
          )}

          {/* Issues */}
          <div className="flex flex-col gap-2.5">
            <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
              Identified Issues ({filteredIssues.length})
            </h4>
            {filteredIssues.length === 0 ? (
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs text-center">
                🎉 No issues detected!
              </div>
            ) : (
              filteredIssues.map((issue, idx) => (
                <div key={idx} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <SeverityBadge severity={issue.severity} />
                      <CategoryBadge category={issue.category} />
                    </div>
                    {(issue.file || issue.line !== null) && (
                      <span className="text-[10px] font-mono text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800 break-all">
                        {issue.file ?? "Line"}{issue.file && issue.line !== null ? `:${issue.line}` : issue.line !== null ? ` ${issue.line}` : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-200 leading-relaxed">{issue.message}</p>
                  {issue.suggestion && (
                    <div className="mt-1 bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">
                          💡 Suggested Fix
                        </span>
                        <button
                          onClick={() => handleCopy(issue.suggestion!, idx)}
                          className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition border border-zinc-700"
                        >
                          {copiedIdx === idx ? "✓ Copied" : "Copy"}
                        </button>
                      </div>
                      <pre className="font-mono text-[11px] text-zinc-300 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                        {issue.suggestion}
                      </pre>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Review ID + link */}
          <div className="flex items-center justify-between border-t border-zinc-800/60 pt-3">
            <span className="text-[10px] text-zinc-600 font-mono">Review ID: {reviewResult.id}</span>
            <Link
              href={`/reviews/${reviewResult.id}`}
              className="text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold"
            >
              View full report ↗
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
