"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { ArrowRight, ShieldCheck } from "@phosphor-icons/react";
import { PixelLoaderBlock } from "./ui/PixelLoader";
import FlickeringGrid from "./ui/FlickeringGrid";

/**
 * Like CodeRabbit: nothing but the install prompt until the user has an
 * active GitHub App installation. Children don't mount (or fetch) before then.
 * Signed-out users pass through — pages render their own sign-in state.
 */
export default function InstallGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    fetch("/api/github/app/installations")
      .then((r) => (r.ok ? r.json() : { installations: [] }))
      .then((json: { installations?: { status: string }[] }) => {
        if (!cancelled) setInstalled((json.installations ?? []).some((i) => i.status === "active"));
      })
      .catch(() => {
        if (!cancelled) setInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  if (!isLoaded) return <PixelLoaderBlock className="min-h-[70vh]" />;
  if (!isSignedIn) return <>{children}</>;
  if (installed === null) return <PixelLoaderBlock className="min-h-[70vh]" />;
  if (!installed) return <InstallPrompt />;
  return <>{children}</>;
}

export function InstallPrompt({ action }: { action?: React.ReactNode } = {}) {
  const steps = [
    "Install the CodeGuard GitHub App on your account or organization.",
    "Choose the repositories you'd like reviewed.",
    "Track review metrics and pull request history right here.",
  ];
  return (
    <div className="w-full max-w-5xl mx-auto px-4 md:px-6 py-12">
      <div className="relative overflow-hidden rounded-md border border-cg-border bg-cg-bg/40 px-6 py-14 flex flex-col items-center text-center gap-6 [&>*:not(canvas)]:relative">
        <FlickeringGrid />
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 rounded-full bg-cg-text text-cg-bg flex items-center justify-center">
            <ShieldCheck size={22} weight="fill" />
          </span>
          <span className="text-3xl font-semibold tracking-tight text-cg-text">CodeGuard</span>
        </div>
        <div>
          <h1 className="text-xl font-semibold text-cg-text">Install CodeGuard on your GitHub</h1>
          <p className="text-sm text-cg-muted mt-2 max-w-lg">
            Connect CodeGuard to start reviewing pull requests and unlock review metrics for your team.
          </p>
        </div>
        <ol className="flex flex-col gap-3 text-left">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-3 text-sm text-cg-muted">
              <span className="h-6 w-6 shrink-0 rounded-full bg-cg-raised text-xs font-medium text-cg-text flex items-center justify-center">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
        {action ?? (
          <Link
            href="/install"
            className="h-9 px-4 flex items-center gap-2 rounded border border-cg-border bg-cg-raised text-sm text-cg-text hover:bg-cg-border/60 transition"
          >
            Install GitHub App
            <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </div>
  );
}
