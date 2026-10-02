import React from "react";

/**
 * Pixel skeleton building blocks (dotted, flickering placeholders).
 *
 *   <Skeleton className="h-6 w-40" />                 any shape
 *   <SkeletonText lines={3} />                        paragraph
 *   <SkeletonTable rows={8} cols={5} />               bordered grid
 *   <SkeletonList rows={5} />                         avatar + two-line rows
 *   <PageSkeleton />                                  title + filters + table
 *
 * All are aria-hidden; wrap a region in <SkeletonRegion label="…"> so screen
 * readers hear one "Loading …" instead of nothing.
 */

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden className={`cg-skel ${className}`} style={style} />;
}

export function SkeletonRegion({ label = "Loading", className = "", children }: { label?: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={className}>
      {children}
    </div>
  );
}

// Fixed widths (not random) so server and client render the same markup.
const TEXT_WIDTHS = ["100%", "92%", "84%", "96%", "70%", "88%"];

export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="h-3"
          style={{ width: i === lines - 1 && lines > 1 ? "60%" : TEXT_WIDTHS[i % TEXT_WIDTHS.length] }}
        />
      ))}
    </div>
  );
}

export function SkeletonTable({ rows = 8, cols = 5, className = "" }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={`rounded-md border border-cg-border p-3 ${className}`}>
      <div className="grid gap-x-7 gap-y-5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: rows * cols }, (_, i) => (
          <Skeleton key={i} className="h-5" />
        ))}
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 5, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 !rounded-full shrink-0" />
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton className="h-3" style={{ width: TEXT_WIDTHS[i % TEXT_WIDTHS.length] }} />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Generic page placeholder: title, subtitle, action, filter chips and a table. */
export function PageSkeleton({
  filters = 3,
  rows = 8,
  cols = 5,
  className = "",
}: {
  filters?: number;
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <SkeletonRegion className={`w-full max-w-5xl mx-auto px-4 md:px-6 pt-4 pb-10 flex flex-col gap-7 ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2.5 w-full">
          <Skeleton className="h-10 w-60 max-w-full" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </div>
        <Skeleton className="h-10 w-36 shrink-0 !rounded-md" />
      </div>
      {filters > 0 && (
        <div className="flex flex-wrap gap-2.5">
          {Array.from({ length: filters }, (_, i) => (
            <Skeleton key={i} className="h-10 w-40" />
          ))}
        </div>
      )}
      <SkeletonTable rows={rows} cols={cols} />
    </SkeletonRegion>
  );
}
