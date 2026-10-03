import { useSyncExternalStore } from "react";
import { MEDIA, THEME_KEY } from "./theme-script";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_EVENT = "cg:theme-change";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref !== "system") return pref;
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
}

function apply() {
  const dark = resolve(readPref()) === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Storage blocked — still switch for this page view.
  }
  apply();
  window.dispatchEvent(new Event(THEME_EVENT));
}

function subscribe(cb: () => void) {
  const mq = window.matchMedia(MEDIA);
  // Follow the OS while on "system"; re-sync when another tab changes it.
  const onChange = () => {
    apply();
    cb();
  };
  mq.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener(THEME_EVENT, cb);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener(THEME_EVENT, cb);
  };
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, readPref, () => "system");
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, () => resolve(readPref()), () => "dark");
}
