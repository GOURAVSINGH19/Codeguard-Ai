"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { SeverityBadge, CategoryBadge, ScoreDisplay, SeverityCountBar } from "@/components/ui/SeverityBadge";

interface Issue {
  id?: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "bug" | "performance" | "maintainability" | "style";
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
  overallScore: string | null;
  summary: string | null;
  status: string;
  reviewType: string;
  model: string | null;
  createdAt: string;
  issues: Issue[];
}

export default function ReviewDetailPage() {
  const params = useParams();
  const reviewId = params?.id as string;

  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [showCode, setShowCode] = useState<boolean>(false);

  useEffect(() => {
    if (!reviewId) return;
    fetchReviewDetail();
  }, [reviewId]);

  const fetchReviewDetail = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/reviews/${reviewId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch review details");
      setReview(data.review);
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

  const handleShareLink = () => {
    navigator.clipboard.writeText(window.location.href);
    // Brief visual feedback handled inline
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6 gap-4">
        <div className="w-10 h-10 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400">Loading review...</p>
      </div>
    );
  }

  if (error || !review) {
    return (
      <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 max-w-md w-full text-center flex flex-col items-center gap-4">
          <span className="text-4xl">⚠️</span>
          <h2 className="text-lg font-bold text-white">Review Not Found</h2>
          <p className="text-xs text-zinc-400">{error || "Unable to find this review."}</p>
          <Link
            href="/"
            className="mt-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition border border-zinc-700"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const scoreNum = review.score ?? 0;
  const categories = Array.from(new Set(review.issues.map((i) => i.category)));
  const filteredIssues = review.issues.filter(
    (i) => filterCategory === "all" || i.category === filterCategory
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 sm:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-7">

        {/* Nav */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-400 hover:text-white transition bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800"
          >
            ← Dashboard
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={handleShareLink}
              className="text-[10px] px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white hover:border-zinc-600 transition"
              title="Copy link"
            >
              🔗 Copy link
            </button>
            <span className="text-[10px] text-zinc-600 font-mono hidden sm:block">
              {review.id.slice(0, 8)}…
            </span>
          </div>
        </div>

        {/* Title card */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-xl">
          <div className="flex flex-col gap-2.5 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {review.language && (
                <span className="px-2.5 py-0.5 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-[10px] font-bold uppercase tracking-wider">
                  {review.language}
                </span>
              )}
              <span className="px-2.5 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] font-medium capitalize">
                {review.status}
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-800 text-zinc-400 text-[10px]">
                {review.reviewType.replace(/_/g, " ")}
              </span>
            </div>
            <h1 className="text-xl font-bold text-white">
              {review.title || `${(review.language || "Code").toUpperCase()} Review`}
            </h1>
            <p className="text-xs text-zinc-400">
              {new Date(review.createdAt).toLocaleString()}
              {review.model && <span className="text-zinc-600"> · {review.model}</span>}
            </p>
          </div>

          {/* Score */}
          <div className="md:border-l border-zinc-800 md:pl-6 w-full md:w-44 shrink-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Quality Score</p>
            <ScoreDisplay score={scoreNum} />
          </div>
        </div>

        {/* Severity breakdown */}
        <SeverityCountBar issues={review.issues} />

        {/* Summary */}
        {review.summary && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-2">
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              📋 Executive Summary
            </h2>
            <p className="text-sm text-zinc-300 leading-relaxed bg-zinc-950/70 p-4 rounded-xl border border-zinc-800/80">
              {review.summary}
            </p>
          </div>
        )}

        {/* Code snippet (collapsible) */}
        {review.codeSnippet && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
            <button
              onClick={() => setShowCode(!showCode)}
              className="w-full flex items-center justify-between p-5 text-left hover:bg-zinc-800/30 transition"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                📄 Submitted Code
              </span>
              <span className="text-zinc-500 text-xs">{showCode ? "▲ Hide" : "▼ Show"}</span>
            </button>
            {showCode && (
              <div className="bg-zinc-950 overflow-x-auto max-h-72 border-t border-zinc-800">
                <pre className="font-mono text-xs text-zinc-200 leading-relaxed whitespace-pre p-4">
                  {review.codeSnippet}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Issues */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-200 flex items-center gap-2">
              🔍 Issues ({review.issues.length})
            </h2>
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
                All ({review.issues.length})
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
                  {cat} ({review.issues.filter((i) => i.category === cat).length})
                </button>
              ))}
            </div>
          )}

          {review.issues.length === 0 ? (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-8 text-center text-emerald-400 flex flex-col items-center gap-2">
              <span className="text-3xl">🎉</span>
              <p className="font-semibold text-sm">No issues detected!</p>
              <p className="text-xs text-emerald-400/70">This code passed all checks.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {filteredIssues.map((issue, idx) => (
                <div
                  key={issue.id || idx}
                  className="bg-zinc-900 border border-zinc-800/90 rounded-2xl p-5 flex flex-col gap-3 hover:border-zinc-700 transition"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <SeverityBadge severity={issue.severity} />
                      <CategoryBadge category={issue.category} />
                    </div>
                    {issue.line !== null && (
                      <span className="text-xs font-mono bg-zinc-950 border border-zinc-800 text-zinc-400 px-3 py-1 rounded-md">
                        Line {issue.line}
                      </span>
                    )}
                  </div>

                  <p className="text-xs sm:text-sm text-zinc-200 leading-relaxed">
                    {issue.message}
                  </p>

                  {issue.suggestion && (
                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">
                          💡 Suggested Fix
                        </span>
                        <button
                          onClick={() => handleCopy(issue.suggestion!, idx)}
                          className="text-[10px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition border border-zinc-700"
                        >
                          {copiedIdx === idx ? "✓ Copied" : "Copy Fix"}
                        </button>
                      </div>
                      <pre className="font-mono text-xs text-zinc-200 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                        {issue.suggestion}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-[10px] text-zinc-600 text-center pb-4">
          Review ID: {review.id} · Powered by CodeGuard AI
        </div>

      </div>
    </div>
  );
}
