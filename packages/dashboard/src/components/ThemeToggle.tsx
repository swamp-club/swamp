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

const browserStorage = (): Storage => localStorage;

function readTheme(storage: () => Storage): Theme {
  try {
    const stored = storage().getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function writeTheme(storage: () => Storage, theme: Theme): void {
  try {
    storage().setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice lasts for this page load only.
  }
}

/**
 * `header` sits on the page's surface, as on `/apps`, instead of the dark sidebar.
 * `storage` is the browser's unless a test passes its own.
 */
export function ThemeToggle(
  { placement = "sidebar", storage = browserStorage }: {
    placement?: "sidebar" | "header";
    storage?: () => Storage;
  } = {},
) {
  const header = placement === "header";
  const [theme, setTheme] = useState<Theme>(() => readTheme(storage));

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    writeTheme(storage, theme);
  }, [theme, storage]);

  const buttons: { t: Theme; label: string }[] = [
    { t: "light", label: "☀" },
    { t: "system", label: "▨" },
    { t: "dark", label: "☾" },
  ];

  return (
    <div
      className={`theme-toggle${header ? " theme-toggle--header" : ""}`}
    >
      {buttons.map(({ t, label }) => (
        <button
          type="button"
          key={t}
          className="theme-toggle-button"
          onClick={() => setTheme(t)}
          title={t}
          aria-label={`${t} theme`}
          aria-pressed={theme === t}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
