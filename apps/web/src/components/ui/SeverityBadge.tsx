import React from "react";

type Severity = "critical" | "high" | "medium" | "low";
type Category = "security" | "bug" | "performance" | "maintainability" | "style";

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "bg-rose-500/10 text-rose-400 border-rose-500/30",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/30",
};

const SEVERITY_ICONS: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
};

const CATEGORY_ICONS: Record<Category, string> = {
  security: "🔐",
  bug: "🐛",
  performance: "⚡",
  maintainability: "🔧",
  style: "✨",
};

export function SeverityBadge({ severity }: { severity: string }) {
  const s = (severity?.toLowerCase() ?? "low") as Severity;
  const style = SEVERITY_STYLES[s] ?? SEVERITY_STYLES.low;
  return (
    <span className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded-md border ${style}`}>
      {SEVERITY_ICONS[s]} {s}
    </span>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  const c = (category?.toLowerCase() ?? "other") as Category;
  const icon = CATEGORY_ICONS[c] ?? "📌";
  return (
    <span className="text-[10px] uppercase font-medium text-zinc-300 bg-zinc-800 border border-zinc-700 px-2.5 py-1 rounded-md">
      {icon} {c}
    </span>
  );
}

export function ScoreDisplay({ score }: { score: number }) {
  const color =
    score >= 8.0
      ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
      : score >= 5.0
      ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
      : "text-rose-400 border-rose-500/30 bg-rose-500/10";

  const barColor =
    score >= 8.0 ? "bg-emerald-500" : score >= 5.0 ? "bg-amber-500" : "bg-rose-500";

  return (
    <div className="flex flex-col gap-1.5">
      <div className={`px-4 py-1.5 rounded-xl border text-xl font-extrabold font-mono text-center ${color}`}>
        {score.toFixed(1)} / 10
      </div>
      {/* Progress bar */}
      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${(score / 10) * 100}%` }}
        />
      </div>
    </div>
  );
}

export function SeverityCountBar({
  issues,
}: {
  issues: Array<{ severity: string }>;
}) {
  const counts = {
    critical: issues.filter((i) => i.severity === "critical").length,
    high: issues.filter((i) => i.severity === "high").length,
    medium: issues.filter((i) => i.severity === "medium").length,
    low: issues.filter((i) => i.severity === "low").length,
  };

  return (
    <div className="grid grid-cols-4 gap-2">
      {(["critical", "high", "medium", "low"] as Severity[]).map((s) => (
        <div
          key={s}
          className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col items-center text-center"
        >
          <span className={`text-xs font-medium ${
            s === "critical" ? "text-rose-400" :
            s === "high" ? "text-orange-400" :
            s === "medium" ? "text-amber-400" : "text-blue-400"
          }`}>
            {SEVERITY_ICONS[s]} {s.charAt(0).toUpperCase() + s.slice(1)}
          </span>
          <span className="text-sm font-bold text-white mt-0.5">{counts[s]}</span>
        </div>
      ))}
    </div>
  );
}
