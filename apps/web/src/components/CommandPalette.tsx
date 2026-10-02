"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChartBar,
  GitPullRequest,
  GithubLogo,
  MagnifyingGlass,
  Plus,
  SquaresFour,
} from "@phosphor-icons/react";
import PixelLoader from "./ui/PixelLoader";
import { NEW_REVIEW_EVENT } from "@/lib/events";

type Item = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  run: () => void;
};

interface ReviewHit {
  id: string;
  title: string | null;
  score: number | null;
}

/** Ctrl/⌘ K palette: jump to a page or search reviews by title. */
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  // Mounted only while open, so every opening starts with a clean query.
  return <Palette onClose={onClose} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<ReviewHit[]>([]);
  const [searching, setSearching] = useState(false);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const pages: Item[] = useMemo(
    () => [
      { id: "p:dash", label: "Dashboard", hint: "PR reviews", icon: SquaresFour, run: () => go("/") },
      {
        id: "a:new",
        label: "New review",
        hint: "Pick a repository to review",
        icon: Plus,
        run: () => {
          onClose();
          // AppShell opens the repository drawer.
          window.dispatchEvent(new Event(NEW_REVIEW_EVENT));
        },
      },
      { id: "p:reports", label: "Reports", hint: "Trends and usage", icon: ChartBar, run: () => go("/reviews/trends") },
      { id: "p:install", label: "GitHub App", hint: "Installations and repositories", icon: GithubLogo, run: () => go("/install") },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const q = query.trim();
  const matchedPages = pages.filter(
    (p) => !q || p.label.toLowerCase().includes(q.toLowerCase()) || p.hint?.toLowerCase().includes(q.toLowerCase())
  );
  const reviewItems: Item[] = hits.map((h) => ({
    id: `r:${h.id}`,
    label: h.title || "Untitled review",
    hint: h.score === null ? undefined : `${h.score.toFixed(1)} / 10`,
    icon: GitPullRequest,
    run: () => go(`/reviews/${h.id}`),
  }));
  const items = [...matchedPages, ...reviewItems];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced review search.
  useEffect(() => {
    if (q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`/api/reviews?q=${encodeURIComponent(q)}&pageSize=6`)
        .then((r) => (r.ok ? r.json() : { reviews: [] }))
        .then((json) => {
          if (!cancelled) setHits(json.reviews ?? []);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setActive(0);
    if (value.trim().length < 2) setHits([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="relative w-full max-w-lg rounded-lg border border-cg-border bg-cg-panel shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      >
        <div className="flex items-center gap-2.5 px-3.5 h-12 border-b border-cg-border">
          <MagnifyingGlass size={16} className="text-cg-subtle shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search pages and reviews..."
            className="flex-1 bg-transparent text-sm text-cg-text placeholder:text-cg-subtle focus:outline-none"
          />
          <kbd className="text-[10px] text-cg-subtle border border-cg-border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {matchedPages.length > 0 && <GroupLabel>Pages</GroupLabel>}
          {matchedPages.map((item, i) => (
            <Row key={item.id} item={item} active={active === i} onHover={() => setActive(i)} />
          ))}

          {q.length >= 2 && (
            <>
              <GroupLabel>Reviews</GroupLabel>
              {searching && hits.length === 0 ? (
                <div className="px-2.5 py-2">
                  <PixelLoader label="Searching" className="!text-xs" />
                </div>
              ) : reviewItems.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-cg-subtle">No reviews match &ldquo;{q}&rdquo;.</p>
              ) : (
                reviewItems.map((item, i) => {
                  const idx = matchedPages.length + i;
                  return <Row key={item.id} item={item} active={active === idx} onHover={() => setActive(idx)} />;
                })
              )}
            </>
          )}

          {items.length === 0 && q.length < 2 && (
            <p className="px-2.5 py-6 text-center text-sm text-cg-subtle">No results.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pt-2 pb-1 text-[11px] text-cg-subtle">{children}</p>;
}

function Row({ item, active, onHover }: { item: Item; active: boolean; onHover: () => void }) {
  const Icon = item.icon;
  return (
    <button
      onMouseMove={onHover}
      onClick={item.run}
      className={`w-full flex items-center gap-2.5 px-2.5 h-9 rounded text-left text-sm transition-colors ${
        active ? "bg-cg-raised text-cg-text" : "text-cg-muted"
      }`}
    >
      <Icon size={16} className="shrink-0" />
      <span className="truncate flex-1">{item.label}</span>
      {item.hint && <span className="text-xs text-cg-subtle truncate">{item.hint}</span>}
    </button>
  );
}
