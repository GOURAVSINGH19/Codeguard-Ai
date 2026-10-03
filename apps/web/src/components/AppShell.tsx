"use client";

import React, { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { SignInButton, Show, useUser } from "@clerk/nextjs";
import {
  CaretDown,
  ChartBar,
  ChartPieSlice,
  GitPullRequest,
  GithubLogo,
  MagnifyingGlass,
  Plus,
  PlugsConnected,
  ShieldCheck,
  SidebarSimple,
  SlidersHorizontal,
  SquaresFour,
} from "@phosphor-icons/react";
import CommandPalette from "./CommandPalette";
import AccountMenu from "./AccountMenu";
import RepoDrawer from "./RepoDrawer";
import ThemeSwitcher from "./ThemeSwitcher";
import { APP_INSTALLED_EVENT, NEW_REVIEW_EVENT } from "@/lib/events";
import { getInstallations, hasActive } from "@/lib/installations";

type Icon = React.ComponentType<{ size?: number; className?: string; weight?: "regular" | "fill" | "bold" }>;
type NavLeaf = { href: string; label: string; icon: Icon };
type NavGroup = { id: string; label: string; icon: Icon; items: NavLeaf[] };

const NAV: NavGroup[] = [
  {
    id: "analytics",
    label: "Analytics",
    icon: ChartPieSlice,
    items: [
      { href: "/", label: "PR reviews", icon: SquaresFour },
      { href: "/reviews/trends", label: "Reports", icon: ChartBar },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: PlugsConnected,
    items: [{ href: "/install", label: "GitHub App", icon: GithubLogo }],
  },
];

// Auth pages render full-screen, without the app chrome.
const BARE_ROUTES = ["/sign-in", "/sign-up"];
const INSTALL_URL = "/api/github/app/install";

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function breadcrumb(pathname: string): string[] {
  if (pathname === "/") return ["Dashboard", "Summary"];
  if (pathname.startsWith("/reviews/trends")) return ["Dashboard", "Reports"];
  if (pathname.startsWith("/reviews/")) return ["Reviews", "Review"];
  if (pathname.startsWith("/install")) return ["Integrations", "GitHub App"];
  if (pathname.startsWith("/profile")) return ["Account", "Profile settings"];
  return ["Dashboard"];
}

// ── Collapsed state, persisted per browser ───────────────────────────────────
const COLLAPSE_KEY = "cg:sidebar-collapsed";
const COLLAPSE_EVENT = "cg:sidebar-collapsed-change";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
  } catch {
    // Storage blocked — the toggle still works for this page view.
  }
  window.dispatchEvent(new Event(COLLAPSE_EVENT));
}
function subscribeCollapsed(cb: () => void) {
  window.addEventListener(COLLAPSE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

interface RecentReview {
  id: string;
  title: string | null;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isSignedIn, user } = useUser();
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ analytics: true, integrations: true });
  const [recents, setRecents] = useState<RecentReview[] | null>(null);
  // Recents stay empty until the GitHub App is installed (null = still checking).
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installVersion, setInstallVersion] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // "New review" from anywhere (sidebar, dashboard, command palette).
  useEffect(() => {
    const open = () => setDrawerOpen(true);
    window.addEventListener(NEW_REVIEW_EVENT, open);
    return () => window.removeEventListener(NEW_REVIEW_EVENT, open);
  }, []);

  useEffect(() => {
    const onInstalled = () => setInstallVersion((v) => v + 1);
    window.addEventListener(APP_INSTALLED_EVENT, onInstalled);
    return () => window.removeEventListener(APP_INSTALLED_EVENT, onInstalled);
  }, []);

  // Ctrl/⌘ K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Recent reviews — refreshed on navigation so a just-finished review (or a
  // fresh install) shows up. Nothing is listed until the app is installed.
  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    // Cached across components and navigations (see lib/installations).
    getInstallations()
      .then(async (rows) => {
        const hasApp = hasActive(rows);
        if (cancelled) return;
        setInstalled(hasApp);
        if (!hasApp) return setRecents([]);
        const r = await fetch("/api/reviews?page=1&pageSize=5");
        const reviews = r.ok ? ((await r.json()).reviews ?? []) : [];
        if (!cancelled) setRecents(reviews);
      })
      .catch(() => {
        if (!cancelled) setRecents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, pathname, installVersion]);

  if (BARE_ROUTES.some((r) => pathname.startsWith(r))) return <>{children}</>;

  const crumbs = breadcrumb(pathname);
  const displayName = user?.username || user?.firstName || "CodeGuard AI";

  // No app yet → nothing to pick from; send them to install it.
  const startNewReview = () => (installed ? setDrawerOpen(true) : router.push("/install"));

  const itemBase = "flex items-center gap-2.5 h-8 rounded text-sm transition-colors";
  const itemIdle = "text-cg-muted hover:text-cg-text hover:bg-cg-raised";

  return (
    <div className="flex min-h-screen bg-cg-bg text-cg-text font-sans">
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {isSignedIn && installed && <RepoDrawer open={drawerOpen} onClose={closeDrawer} />}

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex shrink-0 flex-col sticky top-0 h-screen py-3 transition-[width] duration-200 ${collapsed ? "w-14 px-2" : "w-64 px-2"
          }`}
      >
        {/* Account row */}
        <div className={`h-8 flex items-center ${collapsed ? "justify-center" : "gap-2 px-2"}`}>
          {!collapsed && (
            <Link href="/" className="flex items-center gap-2 min-w-0 flex-1">
              {user?.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- tiny Clerk avatar
                <img src={user.imageUrl} alt="" className="h-5 w-5 rounded-full shrink-0" />
              ) : (
                <span className="h-5 w-5 rounded-full bg-cg-text text-cg-bg flex items-center justify-center shrink-0">
                  <ShieldCheck size={12} weight="fill" />
                </span>
              )}
              <span className="text-sm font-semibold truncate">{displayName}</span>
              <span className="px-1.5 py-px rounded bg-cg-raised text-[11px] text-cg-muted shrink-0">CodeGuard</span>
            </Link>
          )}
          <button
            onClick={() => writeCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="h-7 w-7 flex items-center justify-center rounded text-cg-subtle hover:text-cg-text hover:bg-cg-raised transition shrink-0"
          >
            <SidebarSimple size={16} />
          </button>
        </div>

        {/* Search + new review */}
        <div className="mt-3 flex flex-col gap-0.5">
          <button
            onClick={() => setPaletteOpen(true)}
            title="Search (Ctrl K)"
            className={`${itemBase} ${itemIdle} cursor-pointer ${collapsed ? "justify-center" : "px-2"}`}
          >
            <MagnifyingGlass size={16} />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">Search</span>
                <kbd className="text-[11px] text-cg-muted border border-cg-border rounded px-1.5 leading-5">Ctrl K</kbd>
              </>
            )}
          </button>
          {isSignedIn && (
            <button
              onClick={startNewReview}
              title="New review"
              className={`${itemBase} ${itemIdle} cursor-pointer ${collapsed ? "justify-center" : "px-2"}`}
            >
              <Plus size={16} />
              {!collapsed && <span>New review</span>}
            </button>
          )}
        </div>

        <div className="my-3 border-t border-cg-border" />

        <nav className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
          {!collapsed && <p className="px-2 pb-1 text-xs text-cg-subtle">Product</p>}

          {collapsed
            ? NAV.flatMap((g) => g.items).map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  className={`${itemBase} justify-center ${active ? "bg-cg-raised text-cg-accent" : itemIdle}`}
                >
                  <item.icon size={16} weight={active ? "fill" : "regular"} />
                </Link>
              );
            })
            : NAV.map((group) => {
              const open = openGroups[group.id];
              const groupActive = group.items.some((i) => isActive(pathname, i.href));
              return (
                <div key={group.id} className="flex flex-col">
                  <button
                    onClick={() => setOpenGroups((s) => ({ ...s, [group.id]: !open }))}
                    aria-expanded={open}
                    className={`${itemBase} px-2 ${groupActive ? "bg-cg-raised text-cg-text" : itemIdle}`}
                  >
                    <group.icon size={16} />
                    <span className="flex-1 text-left">{group.label}</span>
                    <CaretDown
                      size={12}
                      className={`text-cg-subtle transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </button>
                  {open && (
                    <div className="ml-[15px] my-1 flex flex-col border-l border-cg-border">
                      {group.items.map((item) => {
                        const active = isActive(pathname, item.href);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            className={`-ml-px pl-4 h-8 flex items-center text-sm border-l transition-colors ${active
                              ? "border-cg-accent text-cg-accent"
                              : "border-transparent text-cg-muted hover:text-cg-text"
                              }`}
                          >
                            {item.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

          {/* Recents */}
          {isSignedIn && !collapsed && (
            <>
              <div className="my-3 border-t border-cg-border" />
              <p className="px-2 pb-1 text-xs text-cg-subtle">Recents</p>
              {recents === null ? null : recents.length === 0 ? (
                <div className="mx-0.5 rounded border border-dashed border-cg-border px-3 py-4 flex flex-col items-center gap-2 text-center">
                  <p className="text-xs text-cg-muted">
                    {installed ? "No reviews requested by you yet." : "No recents"}
                  </p>
                  {installed && (
                    <button
                      onClick={startNewReview}
                      className="h-7 px-2.5 rounded bg-cg-raised text-xs text-cg-text hover:bg-cg-border/60 transition"
                    >
                      New review
                    </button>
                  )}
                </div>
              ) : (
                recents.map((r) => (
                  <Link
                    key={r.id}
                    href={`/reviews/${r.id}`}
                    className={`${itemBase} px-2 ${pathname === `/reviews/${r.id}` ? "bg-cg-raised text-cg-text" : itemIdle
                      }`}
                  >
                    <GitPullRequest size={15} className="shrink-0" />
                    <span className="truncate">{r.title || "Untitled review"}</span>
                  </Link>
                ))
              )}
            </>
          )}
        </nav>

        {/* Quick actions + footer */}
        <div className="pt-2 flex flex-col gap-0.5">
          {isSignedIn && (
            <>
              <div className="mb-2 border-t border-cg-border" />
              {!collapsed && <p className="px-2 pb-1 text-xs text-cg-subtle">Quick actions</p>}
              <a href={INSTALL_URL} title="Add repositories" className={`${itemBase} ${itemIdle} ${collapsed ? "justify-center" : "px-2"}`}>
                <Plus size={16} />
                {!collapsed && "Add repositories"}
              </a>
              <Link href="/install" title="Auto-review settings" className={`${itemBase} ${itemIdle} ${collapsed ? "justify-center" : "px-2"}`}>
                <SlidersHorizontal size={16} />
                {!collapsed && "Auto-review settings"}
              </Link>
            </>
          )}
          <div className="my-2 border-t border-cg-border" />

          <ThemeSwitcher collapsed={collapsed} />

          <Show when="signed-in">
            <div className="mt-1">
              <AccountMenu collapsed={collapsed} />
            </div>
          </Show>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button
                title="Sign in with GitHub"
                className={`mt-1 flex items-center justify-center gap-2 h-8 rounded bg-cg-text text-cg-bg text-sm font-medium hover:opacity-90 transition ${collapsed ? "" : "mx-1"
                  }`}
              >
                <GithubLogo size={15} weight="fill" />
                {!collapsed && "Sign in with GitHub"}
              </button>
            </SignInButton>
          </Show>
        </div>
      </aside>

      {/* ── Inset content panel ─────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col md:py-2 md:pr-2">
        <div className="flex-1 min-w-0 flex flex-col bg-cg-panel md:rounded-md md:border border-cg-border">
          <header className="h-12 px-4 md:px-6 flex items-center justify-between gap-3 border-b md:border-b-0 border-cg-border sticky top-0 z-10 bg-cg-panel md:rounded-t-md">
            <Link href="/" className="md:hidden flex items-center gap-2">
              <span className="h-6 w-6 rounded-full bg-cg-text text-cg-bg flex items-center justify-center">
                <ShieldCheck size={14} weight="fill" />
              </span>
              <span className="text-sm font-semibold">CodeGuard AI</span>
            </Link>
            <ol className="hidden md:flex items-center gap-2 text-sm">
              {crumbs.map((c, i) => (
                <li key={c} className="flex items-center gap-2">
                  {i > 0 && <span className="text-cg-subtle/60">/</span>}
                  <span className={i === crumbs.length - 1 ? "text-cg-text" : "text-cg-muted"}>{c}</span>
                </li>
              ))}
            </ol>
            {/* Mobile nav */}
            <div className="md:hidden flex items-center gap-1">
              <button onClick={() => setPaletteOpen(true)} aria-label="Search" className="p-1.5 rounded text-cg-muted">
                <MagnifyingGlass size={17} />
              </button>
              {NAV.flatMap((g) => g.items).map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  className={`p-1.5 rounded ${isActive(pathname, item.href) ? "bg-cg-raised text-cg-accent" : "text-cg-muted"}`}
                >
                  <item.icon size={17} />
                </Link>
              ))}
              <Show when="signed-in">
                <div className="ml-1">
                  <AccountMenu placement="header" />
                </div>
              </Show>
            </div>
          </header>
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
