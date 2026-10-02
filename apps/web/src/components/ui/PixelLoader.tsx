import React from "react";

// Per-cell opacity range and phase, so the grid shimmers rather than blinking in unison.
const CELLS = [
  { lo: 0.25, hi: 1, delay: 0 },
  { lo: 0.15, hi: 0.8, delay: 0.35 },
  { lo: 0.3, hi: 1, delay: 0.7 },
  { lo: 0.15, hi: 0.9, delay: 0.55 },
  { lo: 0.35, hi: 1, delay: 0.15 },
  { lo: 0.1, hi: 0.7, delay: 0.9 },
  { lo: 0.3, hi: 0.95, delay: 0.8 },
  { lo: 0.1, hi: 0.75, delay: 0.25 },
  { lo: 0.25, hi: 1, delay: 0.45 },
];

export function PixelGrid({ cell = 4, gap = 1 }: { cell?: number; gap?: number }) {
  return (
    <span
      aria-hidden
      className="inline-grid shrink-0"
      style={{ gridTemplateColumns: `repeat(3, ${cell}px)`, gridAutoRows: `${cell}px`, gap }}
    >
      {CELLS.map((c, i) => (
        <span
          key={i}
          className="pxs-cell bg-current"
          style={
            {
              "--lo": c.lo,
              "--hi": c.hi,
              "--mid": (c.lo + c.hi) / 2,
              "--delay": `${c.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}

/** CodeRabbit-style loader: pulsing pixel grid + "Loading..." with cycling dots. */
export default function PixelLoader({
  label = "Loading",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span role="status" className={`inline-flex items-center gap-2 text-sm text-cg-muted ${className}`}>
      <PixelGrid />
      <span className="cg-dots">{label}</span>
    </span>
  );
}

/** Centered loader that fills its container — for whole pages or panels. */
export function PixelLoaderBlock({ label, className = "" }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center py-16 ${className}`}>
      <PixelLoader label={label} />
    </div>
  );
}
