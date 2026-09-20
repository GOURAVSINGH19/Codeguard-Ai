"use client";

import React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";

interface CategoryBreakdownPoint {
  category: string;
  severity: string;
  count: number;
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#f43f5e",
  high: "#fb923c",
  medium: "#fbbf24",
  low: "#22c55e",
  major: "#fb923c",
  minor: "#fbbf24",
  suggestion: "#06b6d4",
  info: "#64748b",
};

interface IssueCategoryChartProps {
  data: CategoryBreakdownPoint[];
  height?: number;
}

export default function IssueCategoryChart({ data, height = 280 }: IssueCategoryChartProps) {
  if (!data.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-zinc-500">
        No issue category data available
      </div>
    );
  }

  // Aggregate by category for the bar chart, with severity as stack
  const categoryMap = new Map<string, Map<string, number>>();
  for (const item of data) {
    if (!categoryMap.has(item.category)) {
      categoryMap.set(item.category, new Map());
    }
    const catMap = categoryMap.get(item.category)!;
    catMap.set(item.severity, (catMap.get(item.severity) || 0) + item.count);
  }

  const categories = Array.from(categoryMap.keys()).sort();
  const severities = Array.from(
    new Set(data.map((d) => d.severity))
  ).sort((a, b) => {
    const order = ["critical", "high", "medium", "low", "major", "minor", "suggestion", "info"];
    return order.indexOf(a) - order.indexOf(b);
  });

  const chartData = categories.map((cat) => {
    const catData: Record<string, number | string> = { category: cat };
    for (const sev of severities) {
      catData[sev] = categoryMap.get(cat)?.get(sev) || 0;
    }
    return catData;
  });

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
      <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Issues by Category & Severity
      </h4>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
            <XAxis type="number" stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="category"
              width={100}
              stroke="#71717a"
              fontSize={10}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#18181b",
                border: "1px solid #27272a",
                borderRadius: "8px",
              }}
              labelStyle={{ color: "#fafafa" }}
              formatter={(value: number, name: string) => [`${value}`, name]}
            />
            <Legend />
            {severities.map((sev, index) => (
              <Bar
                key={sev}
                dataKey={sev}
                stackId="a"
                fill={SEVERITY_COLORS[sev] || "#71717a"}
                name={sev.charAt(0).toUpperCase() + sev.slice(1)}
                radius={[0, 4, 4, 0]}
              >
                {chartData.map((_, i) => (
                  <Cell key={`cell-${i}-${sev}`} fill={SEVERITY_COLORS[sev] || "#71717a"} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}