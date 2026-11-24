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

/** The picker's value for swamp's own look. */
export const STOCK_THEME = "swamp";

export interface ThemeEntry<T> {
  readonly id: string;
  readonly label: string;
  readonly theme: T;
}

export interface ThemeList<T> {
  readonly themes: readonly ThemeEntry<T>[];
  readonly default: string | null;
  readonly locked: boolean;
  readonly errors: readonly { readonly id: string; readonly error: string }[];
}

/**
 * The served list, keeping the last good copy of any theme the server now
 * reports as broken, so a bad edit never un-brands an open page.
 */
export function mergeThemes<T>(
  previous: ThemeList<T> | null,
  next: ThemeList<T>,
): ThemeList<T> {
  if (previous === null) return next;
  const broken = new Set(next.errors.map((e) => e.id));
  const served = new Set(next.themes.map((t) => t.id));
  const kept = previous.themes.filter((t) =>
    broken.has(t.id) && !served.has(t.id)
  );
  const themes = [...next.themes, ...kept].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const keepDefault = next.default === null && previous.default !== null &&
    broken.has(previous.default);
  return {
    themes,
    default: keepDefault ? previous.default : next.default,
    locked: keepDefault ? previous.locked : next.locked,
    errors: next.errors,
  };
}

/** The theme to show: a locked default, else the viewer's pick, else the default. */
export function shownThemeId<T>(
  list: ThemeList<T>,
  choice: string | null,
): string | null {
  const known = (id: string | null) =>
    id !== null && list.themes.some((t) => t.id === id);
  if (list.locked && known(list.default)) return list.default;
  if (choice === STOCK_THEME) return null;
  if (known(choice)) return choice;
  return known(list.default) ? list.default : null;
}

/** The picker shows only when there is something to switch between. */
export function pickerOptions<T>(
  list: ThemeList<T>,
): { value: string; label: string }[] {
  if (list.locked || list.themes.length === 0) return [];
  return [
    { value: STOCK_THEME, label: "Swamp" },
    ...list.themes.map((t) => ({ value: t.id, label: t.label })),
  ];
}
