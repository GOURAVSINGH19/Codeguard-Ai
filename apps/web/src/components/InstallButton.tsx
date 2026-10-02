"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, GithubLogo } from "@phosphor-icons/react";
import PixelLoader from "./ui/PixelLoader";
import { APP_INSTALLED_EVENT } from "@/lib/events";
import { getInstallations, hasActive, invalidateInstallations } from "@/lib/installations";

// Starts the install flow server-side (sets the CSRF state cookie, then redirects to GitHub).
export const INSTALL_URL = "/api/github/app/install";

const POLL_MS = 10_000;
const GIVE_UP_MS = 10 * 60 * 1000;

/**
 * Opens the GitHub App install page in a new tab and waits here until the
 * installation shows up — so the user lands back in CodeGuard even when
 * GitHub doesn't redirect (no Setup URL, or installing an already-configured
 * account). Detection runs when this tab becomes visible again, and polls only
 * while it is visible; the server links the installation to the user on that
 * request.
 */
export default function InstallButton({
  onInstalled,
  label = "Install GitHub App",
  className = "",
}: {
  onInstalled: () => void;
  label?: string;
  className?: string;
}) {
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(0);

  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      if (hasActive(await getInstallations({ fresh: true }))) {
        setWaiting(false);
        invalidateInstallations();
        window.dispatchEvent(new Event(APP_INSTALLED_EVENT));
        onInstalled();
      } else if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setTimedOut(true);
      }
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, [onInstalled]);

  useEffect(() => {
    if (!waiting || timedOut) return;
    // While the user is on the GitHub tab this page is hidden — no point asking.
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [waiting, timedOut, check]);

  const open = () => {
    const tab = window.open(INSTALL_URL, "_blank");
    if (!tab) {
      // Popup blocked — fall back to a normal navigation. Must be a full page
      // load: the API route sets a cookie and redirects off-site to GitHub.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(INSTALL_URL);
      return;
    }
    tab.opener = null;
    startedAt.current = Date.now();
    setTimedOut(false);
    setWaiting(true);
  };

  if (!waiting) {
    return (
      <button
        onClick={open}
        className={`h-9 px-4 flex items-center gap-2 rounded bg-cg-text text-cg-bg text-sm font-medium hover:opacity-90 transition ${className}`}
      >
        <GithubLogo size={16} weight="fill" />
        {label}
      </button>
    );
  }

  return (
    <div role="status" className="w-full max-w-md rounded-md border border-cg-border bg-cg-panel/80 px-4 py-3.5 flex flex-col items-center gap-3 text-center">
      {timedOut ? (
        <p className="text-sm text-cg-muted">Still not seeing an installation.</p>
      ) : (
        <PixelLoader label="Waiting for GitHub" />
      )}
      <p className="text-xs text-cg-subtle leading-relaxed">
        Finish installing in the GitHub tab and choose your repositories. This page updates automatically — no need to
        come back through GitHub.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            startedAt.current = Date.now();
            setTimedOut(false);
            void check();
          }}
          disabled={checking}
          className="h-7 px-2.5 rounded bg-cg-raised text-xs text-cg-text hover:bg-cg-border/60 transition disabled:opacity-60"
        >
          {checking ? "Checking…" : "I've installed it"}
        </button>
        <a
          href={INSTALL_URL}
          target="_blank"
          rel="noreferrer"
          className="h-7 px-2.5 flex items-center gap-1.5 rounded border border-cg-border text-xs text-cg-muted hover:text-cg-text transition"
        >
          Open GitHub again
          <ArrowSquareOut size={12} />
        </a>
        <button onClick={() => setWaiting(false)} className="h-7 px-2 text-xs text-cg-subtle hover:text-cg-text transition">
          Cancel
        </button>
      </div>
    </div>
  );
}
