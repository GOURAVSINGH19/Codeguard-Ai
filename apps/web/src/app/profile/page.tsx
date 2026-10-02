"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import {
  ArrowSquareOut,
  CheckCircle,
  Copy,
  GithubLogo,
  PencilSimple,
  SignOut,
} from "@phosphor-icons/react";
import PixelLoader from "@/components/ui/PixelLoader";
import { Skeleton, SkeletonRegion, SkeletonText } from "@/components/ui/PixelSkeleton";

interface Stats {
  reviews: number;
  installations: number;
}

function formatDate(d: Date | null | undefined) {
  return d ? new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "—";
}

export default function ProfilePage() {
  const { isLoaded, user } = useUser();
  const { openUserProfile, signOut } = useClerk();
  const [stats, setStats] = useState<Stats | null>(null);
  const [copied, setCopied] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/reviews?page=1&pageSize=1").then((r) => (r.ok ? r.json() : { total: 0 })),
      fetch("/api/github/app/installations").then((r) => (r.ok ? r.json() : { installations: [] })),
    ])
      .then(([reviews, inst]) => {
        if (cancelled) return;
        setStats({
          reviews: reviews.total ?? 0,
          installations: (inst.installations ?? []).filter((i: { status: string }) => i.status === "active").length,
        });
      })
      .catch(() => {
        if (!cancelled) setStats({ reviews: 0, installations: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!isLoaded || !user) return <ProfileSkeleton />;

  const name = user.fullName || user.username || "Your account";
  const email = user.primaryEmailAddress?.emailAddress;
  const github = user.externalAccounts.find((a) => a.provider === "github");
  const githubLogin = github?.username || user.username;

  const copyId = async () => {
    await navigator.clipboard.writeText(user.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="w-full max-w-3xl mx-auto px-4 md:px-6 pt-4 pb-12 flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-cg-text">Profile settings</h1>
        <p className="text-sm text-cg-subtle">Your account details and connected services.</p>
      </div>

      {/* Identity */}
      <section className="rounded-md border border-cg-border p-5 flex flex-col sm:flex-row sm:items-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- Clerk avatar */}
        <img src={user.imageUrl} alt="" className="h-16 w-16 rounded-full object-cover shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-cg-text truncate">{name}</p>
          <p className="text-sm text-cg-subtle truncate">{githubLogin ? `@${githubLogin}` : email}</p>
        </div>
        <button
          onClick={() => openUserProfile()}
          className="h-8 px-3 flex items-center gap-1.5 self-start sm:self-auto rounded border border-cg-border bg-cg-raised text-sm text-cg-text hover:bg-cg-border/60 transition"
        >
          <PencilSimple size={14} />
          Edit profile
        </button>
      </section>

      {/* Account details */}
      <Section title="Account">
        <Row label="Full name" value={user.fullName || "—"} />
        <Row label="Username" value={user.username || "—"} />
        <Row label="Email" value={email || "—"} />
        <Row label="Member since" value={formatDate(user.createdAt)} />
        <Row
          label="User ID"
          value={
            <span className="flex items-center gap-2 min-w-0">
              <code className="text-xs text-cg-muted truncate">{user.id}</code>
              <button onClick={copyId} aria-label="Copy user ID" className="text-cg-subtle hover:text-cg-text transition shrink-0">
                {copied ? <CheckCircle size={14} className="text-emerald-400" /> : <Copy size={14} />}
              </button>
            </span>
          }
        />
      </Section>

      {/* Connected accounts */}
      <Section title="Connected accounts">
        <div className="px-4 py-3.5 flex items-center gap-3">
          <span className="h-8 w-8 rounded-full bg-cg-raised flex items-center justify-center shrink-0">
            <GithubLogo size={17} weight="fill" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-cg-text">GitHub</p>
            <p className="text-xs text-cg-subtle truncate">
              {github ? `Connected as @${githubLogin}` : "Not connected"}
            </p>
          </div>
          {githubLogin && (
            <a
              href={`https://github.com/${githubLogin}`}
              target="_blank"
              rel="noreferrer"
              className="h-7 px-2.5 flex items-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition"
            >
              View
              <ArrowSquareOut size={12} />
            </a>
          )}
        </div>
      </Section>

      {/* Usage */}
      <Section title="Usage">
        <div className="grid grid-cols-2 gap-px bg-cg-border">
          <Stat label="Reviews run" value={stats?.reviews} href="/" />
          <Stat label="GitHub App installations" value={stats?.installations} href="/install" />
        </div>
      </Section>

      {/* Session */}
      <Section title="Session">
        <div className="px-4 py-3.5 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-cg-text">Log out</p>
            <p className="text-xs text-cg-subtle">End your session on this device.</p>
          </div>
          <button
            onClick={async () => {
              setSigningOut(true);
              await signOut({ redirectUrl: "/" });
            }}
            disabled={signingOut}
            className="h-8 px-3 flex items-center gap-1.5 rounded border border-rose-500/30 bg-rose-500/10 text-sm text-rose-300 hover:bg-rose-500/20 transition"
          >
            {signingOut ? (
              <PixelLoader label="Logging out" className="!text-rose-300" />
            ) : (
              <>
                <SignOut size={14} />
                Log out
              </>
            )}
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-cg-border overflow-hidden">
      <h2 className="px-4 h-11 flex items-center text-sm font-medium text-cg-text border-b border-cg-border">{title}</h2>
      <div className="divide-y divide-cg-border">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-3 grid grid-cols-[140px_1fr] items-center gap-3 text-sm">
      <span className="text-cg-subtle">{label}</span>
      <span className="text-cg-text min-w-0 truncate">{value}</span>
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: number | undefined; href: string }) {
  return (
    <Link href={href} className="bg-cg-panel p-4 flex flex-col gap-2 hover:bg-cg-raised/50 transition-colors">
      <span className="text-xs text-cg-subtle">{label}</span>
      {value === undefined ? (
        <Skeleton className="h-7 w-12" />
      ) : (
        <span className="text-2xl font-semibold text-cg-text tabular-nums">{value.toLocaleString()}</span>
      )}
    </Link>
  );
}

function ProfileSkeleton() {
  return (
    <SkeletonRegion label="Loading profile" className="w-full max-w-3xl mx-auto px-4 md:px-6 pt-4 pb-12 flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="rounded-md border border-cg-border p-5 flex items-center gap-4">
        <Skeleton className="h-16 w-16 !rounded-full shrink-0" />
        <div className="flex-1">
          <SkeletonText lines={2} className="max-w-xs" />
        </div>
      </div>
      {[5, 1, 1].map((rows, i) => (
        <div key={i} className="rounded-md border border-cg-border p-4 flex flex-col gap-4">
          <Skeleton className="h-4 w-32" />
          {Array.from({ length: rows }, (_, j) => (
            <div key={j} className="grid grid-cols-[140px_1fr] gap-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          ))}
        </div>
      ))}
    </SkeletonRegion>
  );
}
