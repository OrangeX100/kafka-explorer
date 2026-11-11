// Theme state: dark default, "system" follows the OS setting. Applied as a
// data-theme attribute on <html>; the palette lives in styles.css
// ([data-theme="light"] overrides the token block).
import { create } from "zustand";

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "ke.theme";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolve(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme;
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = resolve(theme);
}

const saved = localStorage.getItem(STORAGE_KEY);
const initial: Theme = saved === "light" || saved === "system" ? saved : "dark";
apply(initial);

interface ThemeState {
  theme: Theme;
  resolved: () => ResolvedTheme;
  toggle: () => void;
  set: (t: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: initial,
  resolved: () => resolve(get().theme),
  toggle: () => {
    // Explicit light/dark — choosing one exits system mode.
    const next: ResolvedTheme = resolve(get().theme) === "dark" ? "light" : "dark";
    get().set(next);
  },
  // Single write path: settings page and toggle both land here, so the
  // data-theme attribute and localStorage can never disagree.
  set: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    apply(theme);
    set({ theme });
  },
}));

// Follow live OS theme changes while in system mode.
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", () => {
    if (useTheme.getState().theme === "system") apply("system");
  });
