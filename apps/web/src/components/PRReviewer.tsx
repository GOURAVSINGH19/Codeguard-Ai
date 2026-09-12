"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

interface Repo {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
}

interface PullRequestItem {
  id: number;
  number: number;
  title: string;
  body: string | null;
  authorLogin: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  htmlUrl: string;
}

interface Issue {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "bug" | "performance" | "maintainability" | "style";
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

export default function PRReviewer() {
  const [repos, setRepos] = useState<Repo[]>([]);
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

  useEffect(() => {
    fetchRepos();
  }, []);

  const fetchRepos = async () => {
    setLoadingRepos(true);
    setError(null);
    try {
      const res = await fetch("/api/github/repos");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch GitHub repositories");
      setRepos(data.repos || []);
    } catch (err: any) {
      setError(err.message || "Failed to load repositories");
    } finally {
      setLoadingRepos(false);
    }
  };

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
      if (!res.ok) throw new Error(data.error || "Failed to fetch open pull requests");
      setPulls(data.pulls || []);
    } catch (err: any) {
      setError(err.message || "Failed to load pull requests");
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
      setReviewResult(data);
    } catch (err: any) {
      setError(err.message || "Error performing PR AI review");
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
        body: JSON.stringify({
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          pullNumber: selectedPR.number,
          score: reviewResult.score,
          summary: reviewResult.summary,
          issues: reviewResult.issues,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to post review comment to GitHub");
      setGithubSuccessUrl(data.htmlUrl || selectedPR.htmlUrl);
    } catch (err: any) {
      setError(err.message || "Error posting comment to GitHub");
    } finally {
      setPostingComment(false);
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity?.toLowerCase()) {
      case "critical":
        return "bg-rose-500/10 text-rose-400 border-rose-500/30";
      case "high":
        return "bg-orange-500/10 text-orange-400 border-orange-500/30";
      case "medium":
        return "bg-amber-500/10 text-amber-400 border-amber-500/30";
      case "low":
      default:
        return "bg-blue-500/10 text-blue-400 border-blue-500/30";
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 8.0) return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    if (score >= 5.0) return "text-amber-400 border-amber-500/30 bg-amber-500/10";
    return "text-rose-400 border-rose-500/30 bg-rose-500/10";
  };

  return (
    <div className="flex flex-col gap-8 w-full max-w-6xl mx-auto px-4 py-6 font-mono">
      {/* Top Banner */}
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <span>🚀</span> GitHub Pull Request AI Reviewer
        </h2>
        <p className="text-xs text-zinc-400">
          Select a repository and open PR to extract git diffs, run AI static analysis, and post inline comments to GitHub.
        </p>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
          🚨 <strong>Error:</strong> {error}
        </div>
      )}

      {/* Step 1 & Step 2 Selectors */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Repo Selector */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Step 1: Select Repository ({repos.length})
          </label>
          {loadingRepos ? (
            <div className="text-xs text-zinc-500 py-3 animate-pulse">Loading repositories from GitHub...</div>
          ) : (
            <select
              value={selectedRepo?.fullName || ""}
              onChange={(e) => {
                const found = repos.find((r) => r.fullName === e.target.value);
                if (found) fetchPulls(found);
              }}
              className="bg-zinc-950 text-zinc-200 text-xs rounded-xl px-4 py-3 border border-zinc-800 focus:outline-none focus:border-cyan-500"
            >
              <option value="">-- Choose a Repository --</option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.fullName}>
                  {repo.fullName} {repo.private ? "🔒" : "🌐"}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* PR Selector */}
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
          <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Step 2: Select Open Pull Request ({pulls.length})
          </label>
          {loadingPulls ? (
            <div className="text-xs text-zinc-500 py-3 animate-pulse">Fetching open PRs...</div>
          ) : !selectedRepo ? (
            <div className="text-xs text-zinc-500 py-3">Select a repository first</div>
          ) : pulls.length === 0 ? (
            <div className="text-xs text-amber-400 py-3">No open pull requests in this repository</div>
          ) : (
            <select
              value={selectedPR?.number || ""}
              onChange={(e) => {
                const found = pulls.find((p) => p.number === parseInt(e.target.value, 10));
                setSelectedPR(found || null);
                setReviewResult(null);
                setGithubSuccessUrl(null);
              }}
              className="bg-zinc-950 text-zinc-200 text-xs rounded-xl px-4 py-3 border border-zinc-800 focus:outline-none focus:border-cyan-500"
            >
              <option value="">-- Choose a Pull Request --</option>
              {pulls.map((pr) => (
                <option key={pr.id} value={pr.number}>
                  PR #{pr.number} — {pr.title} ({pr.headBranch} → {pr.baseBranch})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Selected PR Card & Action Button */}
      {selectedPR && (
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-cyan-400">PR #{selectedPR.number}</span>
              <span className="text-xs font-medium text-zinc-300">{selectedPR.title}</span>
            </div>
            <p className="text-[11px] text-zinc-500">
              Author: @{selectedPR.authorLogin} • Branch: <code className="text-zinc-400">{selectedPR.headBranch}</code> → <code className="text-zinc-400">{selectedPR.baseBranch}</code>
            </p>
          </div>

          <button
            onClick={handleRunPRReview}
            disabled={analyzing}
            className="w-full sm:w-auto py-3 px-6 rounded-xl font-medium text-xs bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-black hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10 shrink-0"
          >
            {analyzing ? (
              <>
                <span className="animate-spin text-sm">⏳</span>
                <span>Extracting Diff & Analyzing AI...</span>
              </>
            ) : (
              <>
                <span>⚡ Review PR Diff</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Review Results Section */}
      {reviewResult && (
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-6 shadow-2xl">
          {/* Header Score & Post Button */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-5">
            <div className="flex flex-col gap-1">
              <h3 className="text-lg font-bold text-white">PR #{reviewResult.prNumber} — {reviewResult.title}</h3>
              <p className="text-xs text-zinc-400">
                {reviewResult.changedFiles.length} files changed in PR diff
              </p>
            </div>

            <div className="flex items-center gap-4">
              <div className={`px-4 py-1.5 rounded-xl border text-xl font-extrabold font-mono ${getScoreColor(reviewResult.score)}`}>
                {reviewResult.score.toFixed(1)} / 10
              </div>

              <button
                onClick={handlePostToGitHub}
                disabled={postingComment}
                className="py-2.5 px-4 rounded-xl font-semibold text-xs bg-zinc-800 hover:bg-zinc-700 text-white transition border border-zinc-700 flex items-center gap-2 shadow-md disabled:opacity-50"
              >
                {postingComment ? (
                  <>
                    <span className="animate-spin text-xs">⏳</span>
                    <span>Posting to GitHub...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span>Post Review to GitHub 💬</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {githubSuccessUrl && (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center justify-between">
              <span>🎉 Successfully posted review comment to GitHub PR!</span>
              <a href={githubSuccessUrl} target="_blank" rel="noreferrer" className="underline font-bold">
                View Comment on GitHub ↗
              </a>
            </div>
          )}

          {/* Executive Summary */}
          <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800">
            <h4 className="text-xs font-semibold text-zinc-300 mb-1 uppercase tracking-wider">Executive Summary</h4>
            <p className="text-xs text-zinc-400 leading-relaxed font-sans">{reviewResult.summary}</p>
          </div>

          {/* Changed Files List */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Changed Files ({reviewResult.changedFiles.length})</h4>
            <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              {reviewResult.changedFiles.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between bg-zinc-950 px-3 py-2 rounded-lg border border-zinc-800 text-xs font-mono">
                  <span className="text-zinc-200">{file.filename}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-emerald-400">+{file.additions}</span>
                    <span className="text-rose-400">-{file.deletions}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Identified Issues */}
          <div className="flex flex-col gap-3">
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Identified Issues ({reviewResult.issues.length})</h4>
            {reviewResult.issues.length === 0 ? (
              <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs text-center">
                🎉 No issues detected in this PR diff!
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {reviewResult.issues.map((issue, idx) => (
                  <div key={idx} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${getSeverityBadge(issue.severity)}`}>
                          {issue.severity}
                        </span>
                        <span className="text-[10px] uppercase font-medium text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded">
                          {issue.category}
                        </span>
                      </div>
                      {issue.line !== null && <span className="text-[11px] font-mono text-zinc-400">Line {issue.line}</span>}
                    </div>

                    <p className="text-xs text-zinc-200 leading-normal">{issue.message}</p>

                    {issue.suggestion && (
                      <div className="mt-1 bg-zinc-900 border border-zinc-800 rounded-lg p-2.5">
                        <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider block mb-1">
                          💡 Suggested Fix:
                        </span>
                        <pre className="font-mono text-[11px] text-zinc-300 overflow-x-auto whitespace-pre-wrap">
                          {issue.suggestion}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
