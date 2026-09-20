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
  Cell,
} from "recharts";

interface VelocityPoint {
  week: string;
  reviews: number;
}

interface ReviewVelocityChartProps {
  data: VelocityPoint[];
  height?: number;
}

export default function ReviewVelocityChart({ data, height = 280 }: ReviewVelocityChartProps) {
  if (!data.length) {
    return (
      <div className="h-[280px] flex items-center justify-center text-zinc-500">
        No velocity data available
      </div>
    );
  }

  const formattedData = data.map((d) => ({
    ...d,
    week: new Date(d.week).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  }));

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
      <h4 className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-4">
        Review Velocity (12 weeks)
      </h4>
      <div className="h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={formattedData}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 60, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
            <XAxis type="number" stroke="#71717a" fontSize={10} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="week"
              width={60}
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
              formatter={(value: number) => [`${value}`, "Reviews"]}
            />
            <Bar
              dataKey="reviews"
              fill="#06b6d4"
              radius={[4, 0, 0, 4]}
              name="Reviews"
            >
              {formattedData.map((_, i) => (
                <Cell key={`cell-${i}`} fill="#06b6d4" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}