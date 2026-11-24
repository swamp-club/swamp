// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type { AppTheme } from "../../../app-sdk/bridge.ts";
import { subscribeCustomTheme } from "../theme/custom_theme.ts";

/** The dashboard tokens an app receives; `theme.css` maps them for shadcn. */
export const APP_THEME_TOKENS = [
  "bg",
  "surface",
  "surface-hover",
  "surface-inset",
  "text-1",
  "text-2",
  "text-3",
  "border",
  "border-strong",
  "accent",
  "accent-hover",
  "accent-subtle",
  "on-accent",
  "success",
  "warning",
  "danger",
  "info",
  "running",
  "cancelled",
  "chart-grid",
  "chart-label",
  "font-body",
  "font-mono",
] as const;

export function readAppTheme(): AppTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const token of APP_THEME_TOKENS) {
    tokens[token] = style.getPropertyValue(`--${token}`).trim();
  }
  const chosen = root.getAttribute("data-theme");
  const dark = chosen === "dark" ||
    (chosen !== "light" &&
      globalThis.matchMedia("(prefers-color-scheme: dark)").matches);
  return { mode: dark ? "dark" : "light", tokens };
}

/** Calls back whenever the theme toggle, the system preference or the repo theme changes. */
export function watchAppTheme(onChange: (theme: AppTheme) => void): () => void {
  const notify = () => onChange(readAppTheme());
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const media = globalThis.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", notify);
  // a repo theme changes the tokens without touching data-theme
  const unsubscribe = subscribeCustomTheme(notify);
  return () => {
    unsubscribe();
    observer.disconnect();
    media.removeEventListener("change", notify);
  };
}
