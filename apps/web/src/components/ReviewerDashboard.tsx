"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useUser, SignInButton } from "@clerk/nextjs";
import PRReviewer from "./PRReviewer";
import { SeverityBadge, CategoryBadge, ScoreDisplay, SeverityCountBar } from "./ui/SeverityBadge";

interface Issue {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "bug" | "performance" | "maintainability" | "style";
  line: number | null;
  message: string;
  suggestion: string | null;
}

interface ReviewResult {
  id?: string;
  score: number;
  summary: string;
  issues: Issue[];
  createdAt?: string;
}

const SAMPLE_SNIPPETS: Record<string, { language: string; code: string }> = {
  "SQL Injection": {
    language: "javascript",
    code: `function getUser(id) {\n  const query = \`SELECT * FROM users WHERE id = \${id}\`;\n  return db.query(query);\n}`,
  },
  "Missing Await": {
    language: "typescript",
    code: `async function fetchUserProfile(userId: string) {\n  const response = fetch(\`/api/users/\${userId}\`);\n  const data = response.json(); // Bug: missing await\n  return data.name;\n}`,
  },
  "Resource Leak": {
    language: "python",
    code: `def process_log_file(filename):\n    f = open(filename, 'r')\n    data = f.read()\n    # Missing f.close() or 'with open(...)'\n    return len(data)`,
  },
};

const MAX_CHARS = 8000;

export default function ReviewerDashboard() {
  const { isSignedIn } = useUser();
  const [code, setCode] = useState<string>(SAMPLE_SNIPPETS["SQL Injection"].code);
  const [language, setLanguage] = useState<string>("javascript");
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"snippet" | "pr">("snippet");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("all");

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/reviews");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.reviews || []);
      }
    } catch (e) {
      console.error("Failed to load review history:", e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSignedIn) fetchHistory();
  }, [isSignedIn, fetchHistory]);

  const handleReview = async () => {
    if (loading) return;
    if (!code.trim()) {
      setError("Please paste or type some code to review.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setFilterCategory("all");

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, language, title: title.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to analyze code");
      setResult(data);
      if (isSignedIn) fetchHistory();
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const filteredIssues = result?.issues.filter(
    (i) => filterCategory === "all" || i.category === filterCategory
  ) ?? [];

  const categories = result
    ? Array.from(new Set(result.issues.map((i) => i.category)))
    : [];

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center text-lg shrink-0">
            🛡️
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">CodeGuard AI</h1>
            <p className="text-xs text-zinc-400">
              Static code & PR review powered by Llama 3.3 70B · Graph-aware diff selection · pgvector RAG
            </p>
          </div>
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
        <button
          onClick={() => setActiveTab("snippet")}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition border ${
            activeTab === "snippet"
              ? "bg-zinc-800 text-white border-zinc-700 shadow-md"
              : "bg-transparent text-zinc-400 border-transparent hover:text-zinc-200"
          }`}
        >
          ⚡ Quick Snippet Review
        </button>
        <button
          onClick={() => setActiveTab("pr")}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition border ${
            activeTab === "pr"
              ? "bg-zinc-800 text-cyan-400 border-cyan-500/40 shadow-md"
              : "bg-transparent text-zinc-400 border-transparent hover:text-zinc-200"
          }`}
        >
          🚀 GitHub PR Review
        </button>
      </div>

      {activeTab === "pr" ? (
        <PRReviewer />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* ── Left: Input ── */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
              {/* Language + Title row */}
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1 flex-1 min-w-[120px]">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Language</label>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="bg-zinc-800 text-zinc-200 text-xs rounded-lg px-3 py-2 border border-zinc-700 focus:outline-none focus:border-cyan-500"
                  >
                    {["typescript","javascript","python","go","rust","java","cpp","sql","ruby","php"].map((l) => (
                      <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 flex-[2] min-w-[200px]">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    Review title <span className="text-zinc-600 normal-case">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Auth middleware refactor"
                    maxLength={80}
                    className="bg-zinc-800 text-zinc-200 text-xs rounded-lg px-3 py-2 border border-zinc-700 focus:outline-none focus:border-cyan-500 placeholder:text-zinc-600"
                  />
                </div>
              </div>

              {/* Sample presets */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <span className="text-[10px] text-zinc-500 shrink-0 uppercase tracking-wider">Presets:</span>
                {Object.entries(SAMPLE_SNIPPETS).map(([label, snippet]) => (
                  <button
                    key={label}
                    onClick={() => { setCode(snippet.code); setLanguage(snippet.language); }}
                    className="text-[10px] px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition shrink-0 border border-zinc-700/50"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Code textarea */}
              <div className="relative">
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value.slice(0, MAX_CHARS))}
                  rows={12}
                  placeholder="Paste code snippet here..."
                  className="w-full font-mono text-xs bg-zinc-950 text-zinc-100 p-4 rounded-xl border border-zinc-800 focus:outline-none focus:border-cyan-500 resize-y leading-relaxed"
                />
                {/* Char counter */}
                <span className={`absolute bottom-3 right-3 text-[10px] font-mono ${
                  code.length > MAX_CHARS * 0.9 ? "text-amber-400" : "text-zinc-600"
                }`}>
                  {code.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
                </span>
              </div>

              {/* Submit */}
              <button
                onClick={handleReview}
                disabled={loading || !code.trim()}
                className="w-full py-3 px-4 rounded-xl font-semibold text-sm bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-black hover:opacity-90 transition disabled:opacity-40 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10"
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                    <span>Analyzing...</span>
                  </>
                ) : (
                  <span>⚡ Review Code</span>
                )}
              </button>
            </div>

            {/* History */}
            {isSignedIn ? (
              <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    Recent Reviews
                  </h3>
                  <button
                    onClick={fetchHistory}
                    disabled={historyLoading}
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 transition"
                  >
                    {historyLoading ? "Loading..." : "↻ Refresh"}
                  </button>
                </div>
                {historyLoading ? (
                  <div className="flex flex-col gap-2">
                    {[1,2,3].map((i) => (
                      <div key={i} className="h-10 rounded-lg bg-zinc-800/50 animate-pulse" />
                    ))}
                  </div>
                ) : history.length === 0 ? (
                  <p className="text-xs text-zinc-500 text-center py-3">No reviews yet. Run your first review above.</p>
                ) : (
                  <div className="flex flex-col gap-2 max-h-52 overflow-y-auto pr-1">
                    {history.map((h) => (
                      <Link
                        key={h.id}
                        href={`/reviews/${h.id}`}
                        className="flex items-center justify-between text-xs p-3 rounded-lg bg-zinc-900 border border-zinc-800/60 hover:border-cyan-500/50 transition group"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-zinc-300 group-hover:text-white transition truncate">
                            {h.title || "Code Review"}
                          </span>
                          <span className="text-zinc-600 text-[10px] shrink-0">({h.language})</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            (h.score || 0) >= 8 ? "bg-emerald-500/20 text-emerald-400" :
                            (h.score || 0) >= 5 ? "bg-amber-500/20 text-amber-400" :
                            "bg-rose-500/20 text-rose-400"
                          }`}>
                            {h.score?.toFixed(1)}/10
                          </span>
                          <span className="text-zinc-600 group-hover:text-cyan-400 text-[10px]">→</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-zinc-900/40 border border-dashed border-zinc-700 rounded-2xl p-5 flex flex-col items-center gap-3 text-center">
                <span className="text-2xl">🔐</span>
                <p className="text-xs text-zinc-400 font-medium">Sign in to save your review history</p>
                <SignInButton mode="modal">
                  <button className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition border border-zinc-700">
                    Sign in with GitHub
                  </button>
                </SignInButton>
              </div>
            )}
          </div>

          {/* ── Right: Results ── */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            {error && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
                🚨 <strong>Error:</strong> {error}
              </div>
            )}

            {!result && !loading && !error && (
              <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center text-center gap-3 text-zinc-500 h-full min-h-[350px]">
                <span className="text-4xl">🔍</span>
                <p className="text-sm font-medium text-zinc-400">Ready to Analyze</p>
                <p className="text-xs max-w-xs leading-relaxed text-zinc-500">
                  Paste your code on the left and click <span className="text-zinc-300 font-semibold">Review Code</span>.
                  Uses Llama 3.3 70B with Zod-validated output.
                </p>
              </div>
            )}

            {loading && (
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center text-center gap-4 h-full min-h-[350px]">
                <div className="w-12 h-12 rounded-full border-2 border-cyan-500/20 border-t-cyan-500 animate-spin" />
                <div>
                  <p className="text-sm font-medium text-zinc-200">Analyzing with AI</p>
                  <p className="text-xs text-zinc-500 mt-1">Checking security, bugs, performance...</p>
                </div>
              </div>
            )}

            {result && !loading && (
              <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-5">
                {/* Score + link */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Quality Score</p>
                    <ScoreDisplay score={result.score} />
                  </div>
                  {result.id && (
                    <Link
                      href={`/reviews/${result.id}`}
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold underline underline-offset-4 shrink-0 mt-6"
                    >
                      Full report ↗
                    </Link>
                  )}
                </div>

                {/* Severity breakdown */}
                <SeverityCountBar issues={result.issues} />

                {/* Summary */}
                <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800/80">
                  <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">Executive Summary</h4>
                  <p className="text-xs text-zinc-300 leading-relaxed">{result.summary}</p>
                </div>

                {/* Category filter */}
                {categories.length > 1 && (
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
                      All ({result.issues.length})
                    </button>
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        onClick={() => setFilterCategory(cat)}
                        className={`text-[10px] px-2 py-0.5 rounded border transition capitalize ${
                          filterCategory === cat
                            ? "bg-zinc-700 text-white border-zinc-600"
                            : "text-zinc-400 border-zinc-700 hover:text-white"
                        }`}
                      >
                        {cat} ({result.issues.filter((i) => i.category === cat).length})
                      </button>
                    ))}
                  </div>
                )}

                {/* Issues list */}
                <div className="flex flex-col gap-2.5 max-h-[420px] overflow-y-auto pr-1">
                  {filteredIssues.length === 0 ? (
                    <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs text-center">
                      🎉 No issues in this category!
                    </div>
                  ) : (
                    filteredIssues.map((issue, idx) => (
                      <div key={idx} className="bg-zinc-950 border border-zinc-800/90 rounded-xl p-4 flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <SeverityBadge severity={issue.severity} />
                            <CategoryBadge category={issue.category} />
                          </div>
                          {issue.line !== null && (
                            <span className="text-[10px] font-mono text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                              Line {issue.line}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-200 leading-relaxed">{issue.message}</p>
                        {issue.suggestion && (
                          <div className="mt-1 bg-zinc-900/90 border border-zinc-800 rounded-lg p-3">
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

                <div className="text-[10px] text-zinc-600 text-center border-t border-zinc-800/60 pt-3">
                  🔒 Schema safety guaranteed by Zod · Model: Llama 3.3 70B
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
