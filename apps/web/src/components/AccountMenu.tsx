"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { CaretUpDown, SignOut, UserCircle } from "@phosphor-icons/react";
import PixelLoader from "./ui/PixelLoader";

function Avatar({ src, name, size }: { src?: string; name: string; size: number }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- small Clerk avatar
    <img src={src} alt="" className="rounded-full shrink-0 object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      className="rounded-full shrink-0 bg-cg-raised text-cg-text flex items-center justify-center text-xs font-medium"
      style={{ width: size, height: size }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * Sidebar account row. Click it for a menu with the user's identity,
 * Profile settings and Log out.
 *
 * placement: "sidebar" opens upward (or to the right when collapsed);
 *            "header" is avatar-only and opens downward (mobile top bar).
 */
export default function AccountMenu({
  collapsed = false,
  placement = "sidebar",
}: {
  collapsed?: boolean;
  placement?: "sidebar" | "header";
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;

  const name = user.fullName || user.username || "Account";
  const handle = user.username ?? user.primaryEmailAddress?.emailAddress ?? "";
  const compact = collapsed || placement === "header";

  const position =
    placement === "header"
      ? "top-full right-0 mt-2"
      : collapsed
        ? "left-full bottom-0 ml-2"
        : "bottom-full left-0 right-0 mb-2";

  const logOut = async () => {
    setSigningOut(true);
    await signOut({ redirectUrl: "/" });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={compact ? name : undefined}
        className={`w-full flex items-center gap-2.5 rounded transition-colors hover:bg-cg-raised ${
          open ? "bg-cg-raised" : ""
        } ${compact ? "justify-center p-1" : "px-2 py-1.5"}`}
      >
        <Avatar src={user.imageUrl} name={name} size={compact ? 26 : 28} />
        {!compact && (
          <>
            <span className="min-w-0 flex-1 text-left leading-tight">
              <span className="block text-sm text-cg-text truncate">{name}</span>
              <span className="block text-xs text-cg-subtle truncate">{handle}</span>
            </span>
            <CaretUpDown size={14} className="text-cg-subtle shrink-0" />
          </>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-40 ${position} min-w-60 rounded-lg border border-cg-border bg-cg-panel shadow-2xl p-1.5 animate-in fade-in zoom-in-95 duration-100`}
        >
          <div className="flex items-center gap-3 px-2 py-2">
            <Avatar src={user.imageUrl} name={name} size={36} />
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-semibold text-cg-text truncate">{name}</p>
              <p className="text-xs text-cg-subtle truncate">{handle}</p>
            </div>
          </div>

          <div className="my-1.5 border-t border-cg-border" />

          <Link
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 h-9 px-2 rounded text-sm text-cg-muted hover:text-cg-text hover:bg-cg-raised transition-colors"
          >
            <UserCircle size={17} />
            Profile settings
          </Link>

          <div className="my-1.5 border-t border-cg-border" />

          <button
            role="menuitem"
            onClick={logOut}
            disabled={signingOut}
            className="w-full flex items-center gap-2.5 h-9 px-2 rounded text-sm text-cg-muted hover:text-cg-text hover:bg-cg-raised transition-colors"
          >
            <SignOut size={17} />
            {signingOut ? <PixelLoader label="Logging out" className="!text-sm" /> : "Log out"}
          </button>
        </div>
      )}
    </div>
  );
}
