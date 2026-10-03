"use client";

import { Desktop, Moon, Sun } from "@phosphor-icons/react";
import { setThemePref, useThemePref, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Desktop },
];

/**
 * Light / Dark / System picker for the sidebar footer. Expanded it's a
 * segmented control; collapsed it's one button that cycles through the modes.
 */
export default function ThemeSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const pref = useThemePref();

  if (collapsed) {
    const i = OPTIONS.findIndex((o) => o.value === pref);
    const current = OPTIONS[i];
    const next = OPTIONS[(i + 1) % OPTIONS.length];
    return (
      <button
        onClick={() => setThemePref(next.value)}
        aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
        title={`Theme: ${current.label}`}
        className="flex items-center justify-center h-8 rounded text-cg-muted hover:text-cg-text hover:bg-cg-raised transition-colors"
      >
        <current.icon size={16} />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2 h-8">
      <span className="flex-1 text-sm text-cg-muted">Theme</span>
      <div role="radiogroup" aria-label="Theme" className="flex items-center gap-0.5 rounded-md border border-cg-border p-0.5">
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = pref === value;
          return (
            <button
              key={value}
              role="radio"
              aria-checked={active}
              aria-label={label}
              title={label}
              onClick={() => setThemePref(value)}
              className={`h-6 w-7 flex items-center justify-center rounded transition-colors ${
                active ? "bg-cg-raised text-cg-text" : "text-cg-subtle hover:text-cg-text"
              }`}
            >
              <Icon size={14} weight={active ? "fill" : "regular"} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
