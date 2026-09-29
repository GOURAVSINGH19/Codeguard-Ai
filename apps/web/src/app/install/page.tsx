"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";

const INSTALL_ERRORS: Record<string, string> = {
  not_authenticated: "Please sign in before installing the GitHub App.",
  missing_params: "GitHub did not return the installation details. Make sure the app requests user authorization during installation.",
  invalid_state: "The installation link expired or was opened in another browser. Please start again.",
  forbidden: "Your GitHub account does not have access to that installation.",
  installation_not_found: "GitHub could not find that installation.",
  install_failed: "Installation failed. Please try again.",
};

interface Installation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
  status: string;
  permissions: Record<string, string>;
  events: string[];
  createdAt: string;
}

interface Repository {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  language: string | null;
  autoReviewEnabled: boolean;
  htmlUrl: string;
  installationId: string | null;
}

async function loadInstallData(): Promise<{ installations: Installation[]; repos: Repository[] }> {
  const [installationsRes, reposRes] = await Promise.all([
    fetch("/api/github/app/installations"),
    fetch("/api/github/repos"),
  ]);
  const installations = installationsRes.ok ? ((await installationsRes.json()).installations ?? []) : [];
  const repos = reposRes.ok ? ((await reposRes.json()).repos ?? []) : [];
  return { installations, repos };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export default function InstallPage() {
  // useSearchParams() needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <InstallPageContent />
    </Suspense>
  );
}

function InstallPageContent() {
  const { isSignedIn } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  // Result of the GitHub App callback (/install?success=true or ?error=<code>)
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    return code ? INSTALL_ERRORS[code] ?? "Installation failed. Please try again." : null;
  });
  const [success, setSuccess] = useState(() => searchParams.has("success"));
  const [activeTab, setActiveTab] = useState<"install" | "manage">("install");

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    loadInstallData()
      .then((data) => {
        if (cancelled) return;
        setInstallations(data.installations);
        setRepositories(data.repos);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
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

  const handleInstallClick = () => {
    window.location.href = "/api/github/app/install";
  };

  const handleToggleAutoReview = async (repo: Repository) => {
    try {
      const res = await fetch(`/api/github/repos/${repo.owner}/${repo.name}/auto-review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !repo.autoReviewEnabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not update auto-review");
      }
      setRepositories((prev) =>
        prev.map((r) => (r.id === repo.id ? { ...r, autoReviewEnabled: !repo.autoReviewEnabled } : r))
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const handleUninstall = async (installationId: number) => {
    if (!confirm("Are you sure you want to uninstall the GitHub App? This will disable auto-reviews for all repositories in this installation.")) {
      return;
    }
    try {
      const res = await fetch(`/api/github/app/installations/${installationId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not uninstall the GitHub App");
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    if (success || error) {
      const timer = setTimeout(() => {
        setSuccess(false);
        setError(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [success, error]);

  if (!isSignedIn) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 py-8 flex flex-col gap-8">
        <div className="text-center py-12">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center text-2xl mx-auto mb-6">
            🛡️
          </div>
          <h1 className="text-3xl font-bold text-white mb-4">Install CodeGuard AI GitHub App</h1>
          <p className="text-zinc-400 text-lg max-w-xl mx-auto mb-8">
            Install the CodeGuard AI GitHub App to enable organization-wide automated code reviews
            on all your repositories. No per-user OAuth required.
          </p>
          <button
            onClick={() => window.location.href = "/sign-in?redirect_url=/install"}
            className="px-8 py-3 rounded-xl font-semibold text-lg bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-black hover:opacity-90 transition shadow-lg shadow-emerald-500/10"
          >
            Sign in with GitHub to Install
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-8 flex flex-col gap-8">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-500 flex items-center justify-center text-lg shrink-0">
            🛡️
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">GitHub App Installation</h1>
            <p className="text-xs text-zinc-400">Manage organization-wide automated code reviews</p>
          </div>
        </div>
      </div>

      {success && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
          ✅ GitHub App installed successfully! Repositories are being synced.
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
          🚨 <strong>Error:</strong> {error}
        </div>
      )}

      {/* Tab Switcher */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
        <button
          onClick={() => setActiveTab("install")}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition border ${
            activeTab === "install"
              ? "bg-zinc-800 text-white border-zinc-700 shadow-md"
              : "bg-transparent text-zinc-400 border-transparent hover:text-zinc-200"
          }`}
        >
          📦 Install App
        </button>
        <button
          onClick={() => setActiveTab("manage")}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition border ${
            activeTab === "manage"
              ? "bg-zinc-800 text-cyan-400 border-cyan-500/40 shadow-md"
              : "bg-transparent text-zinc-400 border-transparent hover:text-zinc-200"
          }`}
        >
          ⚙️ Manage Installations
        </button>
      </div>

      {activeTab === "install" ? (
        <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6">
          <div className="max-w-2xl mx-auto text-center">
            <div className="h-24 w-24 rounded-2xl bg-gradient-to-tr from-emerald-500/20 to-cyan-500/20 flex items-center justify-center text-4xl mx-auto mb-6">
              📦
            </div>
            <h2 className="text-xl font-bold text-white mb-4">Install CodeGuard AI GitHub App</h2>
            <p className="text-zinc-400 mb-6 max-w-md mx-auto">
              Install the GitHub App on your organization or personal account to enable
              automated code reviews across all repositories. Once installed, you can
              enable auto-review per repository.
            </p>
            <ul className="text-left text-zinc-300 space-y-3 mb-6 max-w-md mx-auto">
              <li className="flex items-center gap-2">✅ Organization-wide access (no per-user OAuth)</li>
              <li className="flex items-center gap-2">✅ Automatic PR reviews on push/PR events</li>
              <li className="flex items-center gap-2">✅ Per-repository auto-review toggle</li>
              <li className="flex items-center gap-2">✅ Secure installation tokens (no stored credentials)</li>
            </ul>
            <button
              onClick={handleInstallClick}
              disabled={loading}
              className="w-full sm:w-auto px-8 py-3 rounded-xl font-semibold text-base bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-black hover:opacity-90 transition disabled:opacity-40 shadow-lg shadow-emerald-500/10"
            >
              {loading ? "Loading..." : "Install GitHub App"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Current Installations */}
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 mb-4">
              Active Installations ({installations.length})
            </h3>
            {loading ? (
              <div className="h-20 flex items-center justify-center text-zinc-500">Loading...</div>
            ) : installations.length === 0 ? (
              <div className="text-center py-8 text-zinc-500">
                <p className="mb-2">No GitHub App installations found</p>
                <button
                  onClick={() => setActiveTab("install")}
                  className="text-cyan-400 underline text-xs"
                >
                  Install the app first
                </button>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {installations.map((inst) => (
                  <div key={inst.id} className="bg-zinc-950 border border-zinc-800 rounded-xl p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center">
                        {inst.accountAvatarUrl ? (
                          <img src={inst.accountAvatarUrl} alt="" className="h-10 w-10 rounded-lg" />
                        ) : (
                          <span className="text-xl">{inst.accountType === "Organization" ? "🏢" : "👤"}</span>
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-white">{inst.accountLogin}</p>
                        <p className="text-xs text-zinc-500 capitalize">{inst.accountType.toLowerCase()}</p>
                      </div>
                      <span className={`ml-auto px-2 py-1 rounded text-[10px] font-bold ${
                        inst.status === "active" ? "bg-emerald-500/20 text-emerald-400" :
                        inst.status === "suspended" ? "bg-amber-500/20 text-amber-400" :
                        "bg-rose-500/20 text-rose-400"
                      }`}>
                        {inst.status}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1 mb-3">
                      {Object.entries(inst.permissions || {}).slice(0, 5).map(([key, value]) => (
                        <span key={key} className="px-2 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-400">
                          {key}: {value}
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => handleUninstall(inst.installationId)}
                      className="w-full px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-medium hover:bg-rose-500/20 transition"
                    >
                      Uninstall App
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Repository Auto-Review Settings */}
          <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 mb-4">
              Repository Auto-Review Settings ({repositories.length})
            </h3>
            {loading ? (
              <div className="h-20 flex items-center justify-center text-zinc-500">Loading...</div>
            ) : repositories.length === 0 ? (
              <div className="text-center py-8 text-zinc-500">
                No repositories found. Install the GitHub App first.
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                {repositories.map((repo) => (
                  <div
                    key={repo.id}
                    className="flex items-center justify-between px-3 py-3 border-b border-zinc-800/50 last:border-0 hover:bg-zinc-950/50 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-[10px] text-zinc-500 shrink-0">
                        {repo.isPrivate ? "🔒" : "🌐"}
                      </span>
                      <div className="min-w-0">
                        <Link
                          href={repo.htmlUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-zinc-300 hover:text-cyan-400 truncate block"
                        >
                          {repo.fullName}
                        </Link>
                        <p className="text-[10px] text-zinc-500 flex items-center gap-1">
                          {repo.language && <span>{repo.language}</span>}
                          {!repo.installationId && <span className="text-rose-400">(No App access)</span>}
                        </p>
                      </div>
                    </div>
                    {repo.installationId ? (
                      <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={repo.autoReviewEnabled}
                          onChange={() => handleToggleAutoReview(repo)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                      </label>
                    ) : (
                      <span className="text-[10px] text-zinc-600 shrink-0">App not installed</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}