"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import PRReviewer from "./PRReviewer";

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
    code: `function getUser(id) {
  const query = \`SELECT * FROM users WHERE id = \${id}\`;
  return db.query(query);
}`,
  },
  "Missing Await Bug": {
    language: "typescript",
    code: `async function fetchUserProfile(userId: string) {
  const response = fetch(\`/api/users/\${userId}\`);
  const data = response.json(); // Bug: missing await on fetch & json()
  return data.name;
}`,
  },
  "Resource Leak": {
    language: "python",
    code: `def process_log_file(filename):
    f = open(filename, 'r')
    data = f.read()
    # Missing f.close() or 'with open(...)' context manager
    return len(data)`,
  },
};

export default function ReviewerDashboard() {
  const { isSignedIn, user } = useUser();
  const [code, setCode] = useState<string>(SAMPLE_SNIPPETS["SQL Injection"].code);
  const [language, setLanguage] = useState<string>("javascript");
  const [loading, setLoading] = useState<boolean>(false);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);

  const [activeTab, setActiveTab] = useState<"snippet" | "pr">("snippet");

  useEffect(() => {
    if (isSignedIn) {
      fetchHistory();
    }
  }, [isSignedIn]);

  const fetchHistory = async () => {
    try {
      const res = await fetch("/api/reviews");
      if (res.ok) {
        const data = await res.json();
        setHistory(data.reviews || []);
      }
    } catch (e) {
      console.error("Failed to load review history:", e);
    }
  };

  const handleReview = async () => {
    if (loading) return;

    if (!code.trim()) {
      setError("Please paste or type some code to review.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, language }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to analyze code");
      }

      setResult(data);
      if (isSignedIn) {
        fetchHistory();
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-rose-500/10 text-rose-400 border-rose-500/20";
      case "high":
        return "bg-orange-500/10 text-orange-400 border-orange-500/20";
      case "medium":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      case "low":
      default:
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 8.0) return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    if (score >= 5.0) return "text-amber-400 border-amber-500/30 bg-amber-500/10";
    return "text-rose-400 border-rose-500/30 bg-rose-500/10";
  };

  const countSeverity = (severity: string) => {
    return result?.issues.filter((i) => i.severity === severity).length || 0;
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      {/* Top Banner */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center font-bold text-black text-lg">
            🛡️
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">CodeGuard AI Reviewer</h1>
            <p className="text-sm text-zinc-400">
              Autonomous Static Code & Pull Request Reviewer powered by Llama 3.3 70B & Octokit REST API
            </p>
          </div>
        </div>
      </div>

      {/* Mode Switcher Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
        <button
          onClick={() => setActiveTab("snippet")}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition border ${activeTab === "snippet"
            ? "bg-zinc-800 text-white border-zinc-700 shadow-md"
            : "bg-transparent text-zinc-400 border-transparent hover:text-zinc-200"
            }`}
        >
          ⚡ Quick Code Snippet Review
        </button>
        <button
          onClick={() => setActiveTab("pr")}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition border ${activeTab === "pr"
            ? "bg-zinc-800 text-cyan-400 border-cyan-500/40 shadow-md"
            : "bg-transparent text-zinc-400 border-transparent hover:text-zinc-200"
            }`}
        >
          🚀 GitHub Pull Request Reviewer
        </button>
      </div>

      {activeTab === "pr" ? (
        <PRReviewer />
      ) : (

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Code Input Column */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Language
                </label>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="bg-zinc-800 text-zinc-200 text-sm rounded-lg px-3 py-1.5 border border-zinc-700 focus:outline-none focus:border-cyan-500"
                >
                  <option value="typescript">TypeScript</option>
                  <option value="javascript">JavaScript</option>
                  <option value="python">Python</option>
                  <option value="go">Go</option>
                  <option value="rust">Rust</option>
                  <option value="java">Java</option>
                  <option value="cpp">C++</option>
                  <option value="sql">SQL</option>
                </select>
              </div>

              {/* Quick Sample Presets */}
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <span className="text-xs text-zinc-500 shrink-0">Try preset:</span>
                {Object.entries(SAMPLE_SNIPPETS).map(([label, snippet]) => (
                  <button
                    key={label}
                    onClick={() => {
                      setCode(snippet.code);
                      setLanguage(snippet.language);
                    }}
                    className="text-xs px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition shrink-0"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Code Textarea */}
              <div className="relative">
                <textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  rows={12}
                  placeholder="Paste code snippet here..."
                  className="w-full font-mono text-xs sm:text-sm bg-zinc-950 text-zinc-100 p-4 rounded-xl border border-zinc-800 focus:outline-none focus:border-cyan-500 resize-y leading-relaxed"
                />
              </div>

              {/* Submit Button */}
              <button
                onClick={handleReview}
                disabled={loading}
                className="w-full py-3 px-4 rounded-xl font-medium text-sm bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-black hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10"
              >
                {loading ? (
                  <>
                    <span className="animate-spin text-base">⏳</span>
                    <span>Analyzing Code Flaws...</span>
                  </>
                ) : (
                  <>
                    <span>⚡ Review Code</span>
                  </>
                )}
              </button>
            </div>

            {/* Past History */}
            {isSignedIn && history.length > 0 && (
              <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Recent Reviews
                </h3>
                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
                  {history.map((h) => (
                    <Link
                      key={h.id}
                      href={`/reviews/${h.id}`}
                      className="flex items-center justify-between text-xs p-3 rounded-lg bg-zinc-900 border border-zinc-800/60 hover:border-cyan-500/50 transition cursor-pointer group"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-zinc-300 group-hover:text-white transition">
                          {h.title || "Code Review"}
                        </span>
                        <span className="text-zinc-500 text-[10px]">({h.language})</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`px-2 py-0.5 rounded font-bold ${(h.score || 0) >= 8
                            ? "bg-emerald-500/20 text-emerald-400"
                            : (h.score || 0) >= 5
                              ? "bg-amber-500/20 text-amber-400"
                              : "bg-rose-500/20 text-rose-400"
                            }`}
                        >
                          {h.score?.toFixed(1)}/10
                        </span>
                        <span className="text-zinc-400 group-hover:text-cyan-400 text-xs font-semibold">
                          View Details →
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Results Column */}
          <div className="lg:col-span-5 flex flex-col gap-4">
            {error && (
              <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">
                🚨 <strong>Error:</strong> {error}
              </div>
            )}

            {!result && !loading && !error && (
              <div className="bg-zinc-900/40 border border-dashed border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center text-center gap-3 text-zinc-500 h-full min-h-[350px]">
                <span className="text-4xl">🔍</span>
                <p className="text-sm font-medium text-zinc-400">Ready to Analyze</p>
                <p className="text-xs max-w-xs leading-relaxed">
                  Paste your code snippet on the left and click <strong>Review Code</strong> to get Zod-validated static analysis, score, and fix suggestions.
                </p>
              </div>
            )}

            {loading && (
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-10 flex flex-col items-center justify-center text-center gap-4 h-full min-h-[350px]">
                <div className="relative">
                  <div className="w-12 h-12 rounded-full border-2 border-cyan-500/20 border-t-cyan-500 animate-spin" />
                </div>
                <p className="text-sm font-medium text-zinc-200">Evaluating AST & Semantics</p>
                <p className="text-xs text-zinc-500">Checking security, performance, and type safety...</p>
              </div>
            )}

            {result && !loading && (
              <div className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-6">
                {/* Score & Summary */}
                <div className="flex flex-col gap-4 border-b border-zinc-800 pb-5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      Code Quality Score
                    </span>
                    <div className="flex items-center gap-3">
                      {result.id && (
                        <Link
                          href={`/reviews/${result.id}`}
                          className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold underline underline-offset-4"
                        >
                          View Full Page ↗
                        </Link>
                      )}
                      <div
                        className={`px-3 py-1 rounded-xl border text-base font-bold font-mono ${getScoreColor(
                          result.score
                        )}`}
                      >
                        {result.score.toFixed(1)} / 10
                      </div>
                    </div>
                  </div>

                  {/* Severity Breakdown Pills */}
                  <div className="grid grid-cols-4 gap-2">
                    <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col items-center text-center">
                      <span className="text-xs text-rose-400 font-medium">🔴 Critical</span>
                      <span className="text-sm font-bold text-white">{countSeverity("critical")}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col items-center text-center">
                      <span className="text-xs text-orange-400 font-medium">🟠 High</span>
                      <span className="text-sm font-bold text-white">{countSeverity("high")}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col items-center text-center">
                      <span className="text-xs text-amber-400 font-medium">🟡 Medium</span>
                      <span className="text-sm font-bold text-white">{countSeverity("medium")}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col items-center text-center">
                      <span className="text-xs text-blue-400 font-medium">🔵 Low</span>
                      <span className="text-sm font-bold text-white">{countSeverity("low")}</span>
                    </div>
                  </div>

                  {/* Executive Summary */}
                  <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800/80">
                    <h4 className="text-xs font-semibold text-zinc-300 mb-1">Executive Summary</h4>
                    <p className="text-xs text-zinc-400 leading-relaxed">{result.summary}</p>
                  </div>
                </div>

                {/* Identified Issues */}
                <div className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Identified Issues ({result.issues.length})
                  </h3>

                  {result.issues.length === 0 ? (
                    <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs text-center">
                      🎉 Excellent! No security or logic flaws detected in this snippet.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 max-h-[420px] overflow-y-auto pr-1">
                      {result.issues.map((issue, idx) => (
                        <div
                          key={idx}
                          className="bg-zinc-950 border border-zinc-800/90 rounded-xl p-4 flex flex-col gap-2"
                        >
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${getSeverityBadge(
                                  issue.severity
                                )}`}
                              >
                                {issue.severity}
                              </span>
                              <span className="text-[10px] uppercase font-medium text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded">
                                {issue.category}
                              </span>
                            </div>
                            {issue.line !== null && (
                              <span className="text-[11px] font-mono text-zinc-400">
                                Line {issue.line}
                              </span>
                            )}
                          </div>

                          <p className="text-xs text-zinc-200 leading-normal">{issue.message}</p>

                          {issue.suggestion && (
                            <div className="mt-1 bg-zinc-900/90 border border-zinc-800 rounded-lg p-2.5">
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

                {/* Zod Badge */}
                <div className="text-[11px] text-zinc-500 text-center border-t border-zinc-800/60 pt-3">
                  🔒 Guaranteed schema safety via Zod validation
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
