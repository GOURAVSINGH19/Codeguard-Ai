"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

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

      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch review details");
      }

      setReview(data.review);
    } catch (err: any) {
      console.error("Error fetching review detail:", err);
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
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

  const handleCopySuggestion = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
        <div className="w-10 h-10 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin mb-4" />
        <p className="text-sm font-medium text-zinc-400">Loading review details...</p>
      </div>
    );
  }

  if (error || !review) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 max-w-md w-full text-center flex flex-col items-center gap-4">
          <span className="text-4xl">⚠️</span>
          <h2 className="text-lg font-bold text-white">Review Not Found</h2>
          <p className="text-xs text-zinc-400">{error || "Unable to find the requested review."}</p>
          <Link
            href="/"
            className="mt-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-semibold transition border border-zinc-700"
          >
            ← Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const scoreNum = review.score ?? 0;
  const criticalCount = review.issues.filter((i) => i.severity === "critical").length;
  const highCount = review.issues.filter((i) => i.severity === "high").length;
  const mediumCount = review.issues.filter((i) => i.severity === "medium").length;
  const lowCount = review.issues.filter((i) => i.severity === "low").length;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-4 sm:p-8 font-mono">
      <div className="max-w-5xl mx-auto flex flex-col gap-8">
        {/* Navigation Bar */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-semibold text-zinc-400 hover:text-white transition bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800"
          >
            <span>←</span> Back to Dashboard
          </Link>
          <span className="text-xs text-zinc-500 font-mono">ID: {review.id}</span>
        </div>

        {/* Title & Metadata Card */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 shadow-xl">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="px-2.5 py-0.5 rounded-md bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-bold uppercase tracking-wider">
                {review.language || "code"}
              </span>
              <span className="px-2.5 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-medium capitalize">
                Status: {review.status}
              </span>
              {review.reviewType && (
                <span className="px-2.5 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-800 text-zinc-400 text-xs font-medium">
                  {review.reviewType.replace("_", " ")}
                </span>
              )}
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
              {review.title || `${(review.language || "Code").toUpperCase()} Code Review`}
            </h1>
            <p className="text-xs text-zinc-400">
              Reviewed on {new Date(review.createdAt).toLocaleString()}
              {review.model && ` • Model: ${review.model}`}
            </p>
          </div>

          {/* Score Badge */}
          <div className="flex items-center gap-4 border-t md:border-t-0 md:border-l border-zinc-800 pt-4 md:pt-0 md:pl-6">
            <div className="flex flex-col items-end">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">
                Quality Score
              </span>
              <div
                className={`text-2xl font-extrabold font-mono px-4 py-1.5 rounded-xl border mt-1 ${getScoreColor(
                  scoreNum
                )}`}
              >
                {scoreNum.toFixed(1)} / 10
              </div>
            </div>
          </div>
        </div>

        {/* Executive Summary */}
        {review.summary && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              <span>📋</span> Executive Summary
            </h2>
            <p className="text-sm text-zinc-300 leading-relaxed font-sans bg-zinc-950/70 p-4 rounded-xl border border-zinc-800/80">
              {review.summary}
            </p>
          </div>
        )}

        {/* Original Code Snippet (if available) */}
        {review.codeSnippet && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              <span>📄</span> Submitted Code Snippet
            </h2>
            <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 overflow-x-auto max-h-72">
              <pre className="font-mono text-xs text-zinc-200 leading-relaxed whitespace-pre">
                {review.codeSnippet}
              </pre>
            </div>
          </div>
        )}

        {/* Identified Issues */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-200 flex items-center gap-2">
              <span>🔍</span> Identified Issues ({review.issues.length})
            </h2>

            {/* Severity Breakdown Pills */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 font-medium">
                🔴 Critical: {criticalCount}
              </span>
              <span className="text-xs px-2.5 py-1 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400 font-medium">
                🟠 High: {highCount}
              </span>
              <span className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 font-medium">
                🟡 Medium: {mediumCount}
              </span>
              <span className="text-xs px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 font-medium">
                🔵 Low: {lowCount}
              </span>
            </div>
          </div>

          {review.issues.length === 0 ? (
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-8 text-center text-emerald-400 text-sm flex flex-col items-center gap-2">
              <span className="text-3xl">🎉</span>
              <p className="font-semibold">No issues detected!</p>
              <p className="text-xs text-emerald-400/80">
                This code snippet passed all security, performance, and style checks.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {review.issues.map((issue, idx) => (
                <div
                  key={issue.id || idx}
                  className="bg-zinc-900 border border-zinc-800/90 rounded-2xl p-5 flex flex-col gap-3 shadow-lg hover:border-zinc-700 transition"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-xs uppercase font-bold px-2.5 py-1 rounded-md border ${getSeverityBadge(
                          issue.severity
                        )}`}
                      >
                        {issue.severity}
                      </span>
                      <span className="text-xs uppercase font-medium text-zinc-300 bg-zinc-800 border border-zinc-700 px-2.5 py-1 rounded-md">
                        {issue.category}
                      </span>
                    </div>

                    {issue.line !== null && (
                      <span className="text-xs font-mono bg-zinc-950 border border-zinc-800 text-zinc-400 px-3 py-1 rounded-md">
                        Line {issue.line}
                      </span>
                    )}
                  </div>

                  <p className="text-xs sm:text-sm text-zinc-200 leading-relaxed font-sans">
                    {issue.message}
                  </p>

                  {issue.suggestion && (
                    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 flex flex-col gap-2 mt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                          💡 Suggested Fix
                        </span>
                        <button
                          onClick={() => handleCopySuggestion(issue.suggestion!, idx)}
                          className="text-[11px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition border border-zinc-700"
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
      </div>
    </div>
  );
}
