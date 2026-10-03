"use client";

import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import ScoreTrendChart from "@/components/charts/ScoreTrendChart";
import IssueCategoryChart from "@/components/charts/IssueCategoryChart";
import ReviewVelocityChart from "@/components/charts/ReviewVelocityChart";
import { PixelLoaderBlock } from "@/components/ui/PixelLoader";
import InstallGate from "@/components/InstallGate";
import ReviewHistory from "@/components/ReviewHistory";

interface TrendsData {
  scoreTrend: Array<{ date: string; avgScore: number; count: number }>;
  categoryBreakdown: Array<{ category: string; severity: string; count: number }>;
  velocity: Array<{ week: string; reviews: number }>;
  topIssues: Array<{ message: string; count: number }>;
  usage?: { reviews: number; totalTokens: number; avgTokensPerReview: number; avgDurationMs: number };
}

export default function TrendsPage() {
  return (
    <InstallGate>
      <TrendsDashboard />
    </InstallGate>
  );
}

function TrendsDashboard() {
  const { isSignedIn } = useUser();
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("30d");

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 90;
    fetch(`/api/reviews/trends?days=${days}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch trends");
        const json = (await res.json()) as TrendsData;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to fetch trends");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, timeRange]);

  const changeRange = (range: "7d" | "30d" | "90d") => {
    if (range === timeRange) return;
    setLoading(true);
    setTimeRange(range);
  };

  if (!isSignedIn) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold text-cg-text mb-4">Review Trends Dashboard</h1>
          <p className="text-cg-muted mb-6">Sign in to view your code review analytics</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl mx-auto px-4 md:px-6 pt-4 pb-10 flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-cg-text">Reports</h1>
        <p className="text-sm text-cg-subtle">All your pull request reviews, plus quality trends over time.</p>
      </div>

      {/* Every past review — click one for the full report. */}
      <ReviewHistory />

      {/* Trends */}
      {/* <div className="flex items-center justify-between pt-4">
        <h2 className="text-sm font-medium text-cg-text">Trends</h2>
        <div className="flex items-center gap-1">
          {(["7d", "30d", "90d"] as const).map((range) => (
            <button
              key={range}
              onClick={() => changeRange(range)}
              className={`h-7 px-2.5 rounded text-xs transition ${
                timeRange === range ? "bg-cg-raised text-cg-text" : "text-cg-subtle hover:text-cg-text"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
          🚨 <strong>Error:</strong> {error}
        </div>
      )}

      {loading ? (
        <PixelLoaderBlock className="min-h-[50vh]" />
      ) : data ? (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <ScoreTrendChart data={data.scoreTrend} />
            <ReviewVelocityChart data={data.velocity} />
          </div>
          <IssueCategoryChart data={data.categoryBreakdown} />
          {data.topIssues.length > 0 && (
            <div className="bg-cg-bg border border-cg-border rounded-2xl p-4">
              <h4 className="text-[10px] font-semibold text-cg-muted uppercase tracking-wider mb-4">
                Top Recurring Issues
              </h4>
              <div className="space-y-3">
                {data.topIssues.slice(0, 5).map((issue, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between bg-cg-raised border border-cg-border rounded-lg p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-cg-text truncate">{issue.message}</p>
                    </div>
                    <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold shrink-0 ml-3">
                      {issue.count}x
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-4">
            <StatCard
              label="Avg Score (30d)"
              value={data.scoreTrend.length > 0
                ? (data.scoreTrend.reduce((a, b) => a + b.avgScore, 0) / data.scoreTrend.length).toFixed(1)
                : "N/A"}
              icon="⭐"
              color="emerald"
            />
            <StatCard
              label="Total Reviews"
              value={data.scoreTrend.reduce((a, b) => a + b.count, 0)}
              icon="📝"
              color="cyan"
            />
            <StatCard
              label="Total Issues"
              value={data.categoryBreakdown.reduce((a, b) => a + b.count, 0)}
              icon="🔍"
              color="amber"
            />
            <StatCard
              label="Top Category"
              value={data.categoryBreakdown.length > 0
                ? [...data.categoryBreakdown].sort((a, b) => b.count - a.count)[0].category
                : "N/A"}
              icon="🏷️"
              color="violet"
            />
          </div>
          {data.usage && (
            <div className="grid gap-4 md:grid-cols-3">
              <StatCard label="Tokens used" value={data.usage.totalTokens.toLocaleString()} icon="🧮" color="cyan" />
              <StatCard label="Avg tokens / review" value={data.usage.avgTokensPerReview.toLocaleString()} icon="📊" color="violet" />
              <StatCard
                label="Avg review time"
                value={data.usage.avgDurationMs > 0 ? `${(data.usage.avgDurationMs / 1000).toFixed(1)}s` : "N/A"}
                icon="⏱️"
                color="amber"
              />
            </div>
          )}
        </>
      ) : null} */}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: string;
  color: "emerald" | "cyan" | "amber" | "violet";
}) {
  const colorMap = {
    emerald: "bg-emerald-500/20 text-emerald-400 border-emerald-500/20",
    cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/20",
    amber: "bg-amber-500/20 text-amber-400 border-amber-500/20",
    violet: "bg-violet-500/20 text-violet-400 border-violet-500/20",
  };

  return (
    <div className={`bg-cg-bg border rounded-xl p-4 ${colorMap[color]}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl">{icon}</span>
        <p className="text-[10px] font-semibold text-cg-subtle uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-2xl font-bold text-cg-text">{value}</p>
    </div>
  );
}