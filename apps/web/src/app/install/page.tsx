"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SignInButton, useUser } from "@clerk/nextjs";
import {
  ArrowSquareOut,
  Buildings,
  CheckCircle,
  GithubLogo,
  Globe,
  LockSimple,
  MagnifyingGlass,
  Plus,
  User,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import PixelLoader, { PixelLoaderBlock } from "@/components/ui/PixelLoader";
import { InstallPrompt } from "@/components/InstallGate";

const INSTALL_ERRORS: Record<string, string> = {
  not_authenticated: "Please sign in before installing the GitHub App.",
  missing_params: "GitHub did not return the installation details. Make sure the app requests user authorization during installation.",
  invalid_state: "The installation link expired or was opened in another browser. Please start again.",
  forbidden: "Your GitHub account does not have access to that installation.",
  installation_not_found: "GitHub could not find that installation.",
  install_failed: "Installation failed. Please try again.",
};

// Starts the install/configure flow server-side (sets the CSRF state cookie).
const INSTALL_URL = "/api/github/app/install";

interface Installation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
  status: "active" | "suspended" | "deleted";
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
}

interface Repository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  language: string | null;
  autoReviewEnabled: boolean;
  htmlUrl: string;
  installationId: string | null;
}

type RepoFilter = "all" | "enabled" | "no-access";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** Where the owner manages which repos the app can see. */
function githubSettingsUrl(inst: Installation) {
  return inst.accountType === "Organization"
    ? `https://github.com/organizations/${inst.accountLogin}/settings/installations/${inst.installationId}`
    : `https://github.com/settings/installations/${inst.installationId}`;
}

export default function InstallPage() {
  // useSearchParams() needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<PixelLoaderBlock className="min-h-[70vh]" />}>
      <InstallPageContent />
    </Suspense>
  );
}

function InstallPageContent() {
  const { isLoaded, isSignedIn } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [installations, setInstallations] = useState<Installation[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [reposPage, setReposPage] = useState(1);
  const [reposHasMore, setReposHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Result of the GitHub App callback (/install?success=true or ?error=<code>)
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(() => {
    const code = searchParams.get("error");
    if (code) return { kind: "error", text: INSTALL_ERRORS[code] ?? "Installation failed. Please try again." };
    if (searchParams.has("success")) return { kind: "success", text: "GitHub App installed. Your repositories are syncing." };
    return null;
  });

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    Promise.all([
      fetch("/api/github/app/installations").then((r) => (r.ok ? r.json() : { installations: [] })),
      fetch("/api/github/repos?page=1").then((r) => (r.ok ? r.json() : { repos: [], hasMore: false })),
    ])
      .then(([instJson, repoJson]) => {
        if (cancelled) return;
        setInstallations(instJson.installations ?? []);
        setRepos(repoJson.repos ?? []);
        setReposPage(1);
        setReposHasMore(!!repoJson.hasMore);
      })
      .catch((err) => {
        if (!cancelled) setNotice({ kind: "error", text: errorMessage(err) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, reloadKey]);

  // Drop ?success / ?error from the address bar so a refresh doesn't repeat it.
  useEffect(() => {
    if (searchParams.has("success") || searchParams.has("error")) router.replace("/install");
  }, [searchParams, router]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const loadMoreRepos = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const next = reposPage + 1;
      const r = await fetch(`/api/github/repos?page=${next}`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || "Failed to load repositories");
      setRepos((prev) => [...prev, ...(json.repos ?? [])]);
      setReposPage(next);
      setReposHasMore(!!json.hasMore);
    } catch (err) {
      setNotice({ kind: "error", text: errorMessage(err) });
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleAutoReview = async (repo: Repository) => {
    const enabled = !repo.autoReviewEnabled;
    // Optimistic — roll back if the server refuses.
    setRepos((prev) => prev.map((r) => (r.id === repo.id ? { ...r, autoReviewEnabled: enabled } : r)));
    try {
      const res = await fetch(`/api/github/repos/${repo.owner}/${repo.name}/auto-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not update auto-review");
      }
    } catch (err) {
      setRepos((prev) => prev.map((r) => (r.id === repo.id ? { ...r, autoReviewEnabled: !enabled } : r)));
      setNotice({ kind: "error", text: errorMessage(err) });
    }
  };

  const uninstall = async (inst: Installation) => {
    const res = await fetch(`/api/github/app/installations/${inst.installationId}`, { method: "DELETE" });
    if (!res.ok) {
      setNotice({ kind: "error", text: "Could not uninstall the GitHub App" });
      return;
    }
    setNotice({ kind: "success", text: `Uninstalled from ${inst.accountLogin}.` });
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const activeInstalls = installations.filter((i) => i.status !== "deleted");

  if (!isLoaded) return <PixelLoaderBlock className="min-h-[70vh]" />;
  if (!isSignedIn) return <SignedOut />;
  if (loading) return <PixelLoaderBlock className="min-h-[70vh]" />;

  return (
    <div className="w-full max-w-5xl mx-auto px-4 md:px-6 pt-4 pb-10 flex flex-col gap-5">
      {notice && <Notice notice={notice} onClose={() => setNotice(null)} />}

      {activeInstalls.length === 0 ? (
        <InstallPrompt
          action={
            <a
              href={INSTALL_URL}
              className="h-9 px-4 flex items-center gap-2 rounded bg-cg-text text-cg-bg text-sm font-medium hover:opacity-90 transition"
            >
              <GithubLogo size={16} weight="fill" />
              Install GitHub App
            </a>
          }
        />
      ) : (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-cg-text">GitHub App</h1>
              <p className="text-sm text-cg-subtle">Manage where CodeGuard is installed and which repositories it reviews.</p>
            </div>
            <a
              href={INSTALL_URL}
              className="h-8 px-3 flex items-center gap-1.5 self-start sm:self-auto rounded border border-cg-border bg-cg-raised text-sm text-cg-text hover:bg-cg-border/60 transition"
            >
              <Plus size={14} />
              Add account
            </a>
          </div>

          <Section title="Installations" count={activeInstalls.length}>
            <ul className="divide-y divide-cg-border">
              {activeInstalls.map((inst) => (
                <InstallationRow key={inst.id} inst={inst} onUninstall={() => uninstall(inst)} />
              ))}
            </ul>
          </Section>

          <RepositoriesSection
            repos={repos}
            hasMore={reposHasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMoreRepos}
            onToggle={toggleAutoReview}
          />
        </>
      )}
    </div>
  );
}

function InstallationRow({ inst, onUninstall }: { inst: Installation; onUninstall: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOrg = inst.accountType === "Organization";
  const permissions = Object.entries(inst.permissions ?? {});

  return (
    <li className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {inst.accountAvatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- small GitHub avatar, no optimization needed
          <img src={inst.accountAvatarUrl} alt="" className="h-8 w-8 rounded-full shrink-0" />
        ) : (
          <span className="h-8 w-8 rounded-full bg-cg-raised flex items-center justify-center text-cg-muted shrink-0">
            {isOrg ? <Buildings size={16} /> : <User size={16} />}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-cg-text truncate">{inst.accountLogin}</span>
            <StatusPill status={inst.status} />
          </div>
          <p className="text-xs text-cg-subtle mt-0.5" title={permissions.map(([k, v]) => `${k}: ${v}`).join("\n")}>
            {isOrg ? "Organization" : "Personal account"} · {permissions.length} permissions ·{" "}
            installed {new Date(inst.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {confirming ? (
          <>
            <span className="text-xs text-cg-muted">Uninstall from {inst.accountLogin}?</span>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="h-7 px-2.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text transition"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                setBusy(true);
                await onUninstall();
                setBusy(false);
                setConfirming(false);
              }}
              disabled={busy}
              className="h-7 px-2.5 rounded bg-rose-500/15 border border-rose-500/30 text-xs text-rose-300 hover:bg-rose-500/25 transition"
            >
              {busy ? <PixelLoader label="Removing" className="!text-xs !text-rose-300" /> : "Uninstall"}
            </button>
          </>
        ) : (
          <>
            <a
              href={githubSettingsUrl(inst)}
              target="_blank"
              rel="noreferrer"
              className="h-7 px-2.5 flex items-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text hover:bg-cg-raised transition"
            >
              Configure
              <ArrowSquareOut size={12} />
            </a>
            <button
              onClick={() => setConfirming(true)}
              className="h-7 px-2.5 rounded text-xs text-cg-subtle hover:text-rose-300 transition"
            >
              Uninstall
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function RepositoriesSection({
  repos,
  hasMore,
  loadingMore,
  onLoadMore,
  onToggle,
}: {
  repos: Repository[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onToggle: (repo: Repository) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");

  const counts = useMemo(
    () => ({
      all: repos.length,
      enabled: repos.filter((r) => r.autoReviewEnabled).length,
      "no-access": repos.filter((r) => !r.installationId).length,
    }),
    [repos]
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return repos.filter((r) => {
      if (filter === "enabled" && !r.autoReviewEnabled) return false;
      if (filter === "no-access" && r.installationId) return false;
      return !q || r.fullName.toLowerCase().includes(q);
    });
  }, [repos, search, filter]);

  const FILTERS: { id: RepoFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "enabled", label: "Auto-review on" },
    { id: "no-access", label: "No app access" },
  ];

  return (
    <Section title="Repositories" count={repos.length}>
      <div className="px-4 pb-3 flex flex-wrap items-center gap-2 border-b border-cg-border">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories..."
            className="w-full h-8 pl-8 pr-3 rounded border border-cg-border bg-transparent text-sm text-cg-text placeholder:text-cg-subtle focus:outline-none focus:border-cg-muted"
          />
        </div>
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`h-8 px-2.5 rounded text-xs flex items-center gap-1.5 transition ${
                filter === f.id ? "bg-cg-raised text-cg-text" : "text-cg-subtle hover:text-cg-text"
              }`}
            >
              {f.label}
              <span className="tabular-nums text-cg-subtle">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="py-10 text-center text-sm text-cg-subtle">
          {repos.length === 0 ? "No repositories yet. Give the app access to a repository on GitHub." : "No matching repositories."}
        </p>
      ) : (
        <ul className="divide-y divide-cg-border">
          {visible.map((repo) => (
            <li key={repo.id} className="px-4 py-3 flex items-center gap-3 hover:bg-cg-raised/50 transition-colors">
              {repo.private ? (
                <LockSimple size={15} className="text-cg-subtle shrink-0" aria-label="Private" />
              ) : (
                <Globe size={15} className="text-cg-subtle shrink-0" aria-label="Public" />
              )}
              <div className="min-w-0 flex-1">
                <a
                  href={repo.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-cg-text hover:text-cg-accent truncate block"
                >
                  {repo.fullName}
                </a>
                <p className="text-xs text-cg-subtle mt-0.5">
                  {repo.language ?? "—"}
                  {!repo.installationId && <span className="text-amber-300/90"> · App doesn&apos;t have access</span>}
                </p>
              </div>
              {repo.installationId ? (
                <Switch
                  checked={repo.autoReviewEnabled}
                  onChange={() => onToggle(repo)}
                  label={`Auto-review ${repo.fullName}`}
                />
              ) : (
                <a
                  href={INSTALL_URL}
                  className="text-xs text-cg-muted hover:text-cg-text underline-offset-4 hover:underline shrink-0"
                >
                  Grant access
                </a>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && !search.trim() && filter === "all" && (
        <div className="px-4 py-3 border-t border-cg-border flex items-center justify-between text-xs text-cg-subtle">
          <span className="tabular-nums">Showing {repos.length}</span>
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="h-7 px-2.5 rounded border border-cg-border text-cg-muted hover:text-cg-text hover:bg-cg-raised transition disabled:pointer-events-none"
          >
            {loadingMore ? <PixelLoader className="!text-xs" /> : "Load more"}
          </button>
        </div>
      )}
    </Section>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cg-accent/60 ${
        checked ? "bg-cg-accent" : "bg-cg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : ""
        }`}
      />
    </button>
  );
}

function StatusPill({ status }: { status: Installation["status"] }) {
  const style =
    status === "active"
      ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/20"
      : "text-amber-300 bg-amber-500/10 border-amber-500/20";
  return <span className={`px-1.5 py-px rounded border text-[11px] capitalize ${style}`}>{status}</span>;
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-cg-border">
      <div className="px-4 h-12 flex items-center gap-2">
        <h2 className="text-sm font-medium text-cg-text">{title}</h2>
        <span className="min-w-5 h-5 px-1.5 rounded bg-cg-raised text-xs text-cg-muted flex items-center justify-center tabular-nums">
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

function Notice({ notice, onClose }: { notice: { kind: "success" | "error"; text: string }; onClose: () => void }) {
  const ok = notice.kind === "success";
  return (
    <div
      role={ok ? "status" : "alert"}
      className={`flex items-start gap-2.5 rounded-md border px-3.5 py-2.5 text-sm ${
        ok ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200" : "border-rose-500/25 bg-rose-500/10 text-rose-200"
      }`}
    >
      {ok ? <CheckCircle size={17} className="shrink-0 mt-px" /> : <WarningCircle size={17} className="shrink-0 mt-px" />}
      <span className="flex-1">{notice.text}</span>
      <button onClick={onClose} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}

function SignedOut() {
  return (
    <div className="min-h-[75vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center flex flex-col items-center gap-5">
        <span className="h-11 w-11 rounded-full bg-cg-text text-cg-bg flex items-center justify-center">
          <GithubLogo size={22} weight="fill" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-cg-text">Connect CodeGuard to GitHub</h1>
          <p className="text-sm text-cg-muted mt-2 leading-relaxed">
            Sign in to install the GitHub App and turn on automatic reviews for your repositories.
          </p>
        </div>
        <SignInButton mode="modal">
          <button className="h-9 px-4 flex items-center gap-2 rounded bg-cg-text text-cg-bg text-sm font-medium hover:opacity-90 transition">
            <GithubLogo size={16} weight="fill" />
            Sign in with GitHub
          </button>
        </SignInButton>
      </div>
    </div>
  );
}
