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

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const THEME_KEY = "swamp-dashboard-theme";

/** `header` sits on the page's surface, as on `/apps`, instead of the dark sidebar. */
export function ThemeToggle(
  { placement = "sidebar" }: { placement?: "sidebar" | "header" } = {},
) {
  const header = placement === "header";
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) ?? "system",
  );

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const buttons: { t: Theme; label: string }[] = [
    { t: "light", label: "☀" },
    { t: "system", label: "▨" },
    { t: "dark", label: "☾" },
  ];

  return (
    <div
      className="theme-toggle"
      style={{
        display: "flex",
        background: header ? "var(--bg)" : "rgba(255,255,255,0.06)",
        border: header ? "1px solid var(--border)" : undefined,
        borderRadius: 6,
        padding: 2,
        margin: header ? 0 : "0 8px 16px",
        minWidth: header ? 96 : undefined,
      }}
    >
      {buttons.map(({ t, label }) => (
        <button
          type="button"
          key={t}
          onClick={() => setTheme(t)}
          title={t}
          aria-label={`${t} theme`}
          aria-pressed={theme === t}
          style={{
            flex: 1,
            padding: "5px 0",
            border: "none",
            background: theme === t
              ? header ? "var(--surface)" : "rgba(255,255,255,0.1)"
              : "transparent",
            color: theme === t
              ? header ? "var(--text)" : "var(--sidebar-text-active)"
              : header
              ? "var(--text-3)"
              : "var(--sidebar-text)",
            cursor: "pointer",
            borderRadius: 4,
            fontSize: "0.85rem",
            lineHeight: 1,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
