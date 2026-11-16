"use client";

import { useCallback, useEffect, useState } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

/** Also read by the inline pre-paint script in app/layout.tsx. */
const THEME_KEY = "speechmux_theme";
const THEME_COLORS = { dark: "#1c2128", light: "#f6f8fa" } as const;

type ThemeMode = "system" | "light" | "dark";

const OPTIONS: ReadonlyArray<{ mode: ThemeMode; label: string; Icon: LucideIcon }> = [
  { mode: "system", label: "System theme", Icon: Monitor },
  { mode: "light", label: "Light theme", Icon: Sun },
  { mode: "dark", label: "Dark theme", Icon: Moon },
];

function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Apply a theme to <html> and keep the browser-chrome colour (`theme-color`) in step. */
function applyTheme(mode: ThemeMode): void {
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = mode;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[resolveTheme(mode)]);
}

/** Three-way theme switch (system / light / dark) shown in the page header. */
export function ThemeToggle(): React.JSX.Element {
  const [mode, setMode] = useState<ThemeMode>("system");

  // The inline script in layout.tsx has already applied the saved theme before
  // first paint; this only brings the control in line with it after hydration.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") setMode(saved);
    } catch {
      // Storage unavailable — stay on the system theme.
    }
  }, []);

  // While following the system, the CSS switches by itself but `theme-color` does not.
  useEffect(() => {
    if (mode !== "system") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (): void => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  const handleChange = useCallback((next: ThemeMode) => {
    setMode(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not persisting the choice is harmless.
    }
  }, []);

  return (
    <fieldset className="segmented-field theme-toggle">
      <legend className="sr-only">Theme</legend>
      <div className="segmented is-compact">
        {OPTIONS.map(({ mode: value, label, Icon }) => (
          <label key={value} className="segment" title={label}>
            <input
              type="radio"
              name="theme"
              value={value}
              checked={mode === value}
              onChange={() => handleChange(value)}
              aria-label={label}
            />
            <span>
              <Icon size={16} aria-hidden="true" />
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
