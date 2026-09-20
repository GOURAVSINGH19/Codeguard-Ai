"use client";

import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import ScoreTrendChart from "@/components/charts/ScoreTrendChart";
import IssueCategoryChart from "@/components/charts/IssueCategoryChart";
import ReviewVelocityChart from "@/components/charts/ReviewVelocityChart";

interface TrendsData {
  scoreTrend: Array<{ date: string; avgScore: number; count: number }>;
  categoryBreakdown: Array<{ category: string; severity: string; count: number }>;
  velocity: Array<{ week: string; reviews: number }>;
  topIssues: Array<{ message: string; count: number }>;
}

export default function TrendsDashboard() {
  const { isSignedIn } = useUser();
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("30d");

  useEffect(() => {
    if (isSignedIn) {
      fetchTrends();
    }
  }, [isSignedIn, timeRange]);

  const fetchTrends = async () => {
    setLoading(true);
    setError(null);
    try {
      const days = timeRange === "7d" ? 7 : timeRange === "30d" ? 30 : 90;
      const res = await fetch(`/api/reviews/trends?days=${days}`);
      if (!res.ok) throw new Error("Failed to fetch trends");
      const data = await res.json();
      setData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isSignedIn) {
    return (
      <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
        <div className="text-center py-12">
          <h1 className="text-2xl font-bold text-white mb-4">Review Trends Dashboard</h1>
          <p className="text-zinc-400 mb-6">Sign in to view your code review analytics</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center text-lg shrink-0">
              📊
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Review Trends</h1>
              <p className="text-xs text-zinc-400">Quality metrics and patterns over time</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(["7d", "30d", "90d"] as const).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  timeRange === range
                    ? "bg-zinc-800 text-white border-zinc-700"
                    : "bg-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
          🚨 <strong>Error:</strong> {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-72 bg-zinc-900/50 border border-zinc-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : data ? (
        <>
          {/* Score Trend + Velocity */}
          <div className="grid gap-6 md:grid-cols-2">
            <ScoreTrendChart data={data.scoreTrend} />
            <ReviewVelocityChart data={data.velocity} />
          </div>

          {/* Category Breakdown */}
          <IssueCategoryChart data={data.categoryBreakdown} />

          {/* Top Issues */}
          {data.topIssues.length > 0 && (
            <div className="bg-zinc-950 border border-zinc-800 rounded-2xl p-4">
              <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-4">
                Top Recurring Issues
              </h4>
              <div className="space-y-3">
                {data.topIssues.slice(0, 5).map((issue, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-lg p-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-zinc-300 truncate">{issue.message}</p>
                    </div>
                    <span className="px-2 py-1 rounded bg-emerald-500/20 text-emerald-400 text-[10px] font-bold shrink-0 ml-3">
                      {issue.count}x
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary Stats */}
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
                ? data.categoryBreakdown.sort((a, b) => b.count - a.count)[0].category
                : "N/A"}
              icon="🏷️"
              color="violet"
            />
          </div>
        </>
      ) : null}
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
    <div className={`bg-zinc-950 border rounded-xl p-4 ${colorMap[color]}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xl">{icon}</span>
        <p className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{label}</p>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}