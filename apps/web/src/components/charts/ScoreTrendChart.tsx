"use client";

import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface ScoreTrendPoint {
  date: string;
  avgScore: number;
  count: number;
}

interface ScoreTrendChartProps {
  data: ScoreTrendPoint[];
  height?: number;
}

export default function ScoreTrendChart({ data, height = 280 }: ScoreTrendChartProps) {
  if (!data.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-zinc-500">
        No score trend data available
      </div>
    );
  }

  // Format data for display
  const formattedData = data.map((d) => ({
    ...d,
    date: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    avgScore: Number(d.avgScore.toFixed(1)),
  }));

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
      <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Quality Score Trend (30 days)
      </h4>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={formattedData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="date"
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={{ stroke: "#27272a" }}
            />
            <YAxis
              domain={[0, 10]}
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `${value}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#18181b",
                border: "1px solid #27272a",
                borderRadius: "8px",
              }}
              labelStyle={{ color: "#fafafa" }}
              formatter={(value: number) => [`${value.toFixed(1)}/10`, "Avg Score"]}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="avgScore"
              stroke="#22c55e"
              strokeWidth={2}
              dot={{ fill: "#22c55e", strokeWidth: 2, r: 4 }}
              activeDot={{ r: 6 }}
              name="Avg Score"
            />
            <Line
              type="monotone"
              dataKey="count"
              stroke="#06b6d4"
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={{ fill: "#06b6d4", strokeWidth: 2, r: 3 }}
              yAxisId="right"
              name="Review Count"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-4 mt-3 text-[10px]">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-emerald-500" />
          Avg Score
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-cyan-500" />
          Review Count
        </span>
      </div>
    </div>
  );
}