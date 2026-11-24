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

import { assertEquals } from "@std/assert";
import {
  mergeThemes,
  pickerOptions,
  shownThemeId,
  STOCK_THEME,
  type ThemeList,
} from "./theme_choice.ts";

const list = (
  over: Partial<ThemeList<string>> = {},
): ThemeList<string> => ({
  themes: [
    { id: "day", label: "Day game", theme: "day-v1" },
    { id: "night", label: "Night game", theme: "night-v1" },
  ],
  default: "night",
  locked: false,
  errors: [],
  ...over,
});

Deno.test("shownThemeId: the viewer's pick wins, Swamp shows no theme, an unknown pick falls back to the default", () => {
  assertEquals(shownThemeId(list(), "day"), "day");
  assertEquals(shownThemeId(list(), STOCK_THEME), null);
  assertEquals(shownThemeId(list(), "gone"), "night");
  assertEquals(shownThemeId(list(), null), "night");
  assertEquals(shownThemeId(list({ default: null }), null), null);
});

Deno.test("shownThemeId: a locked default ignores the viewer's pick", () => {
  const locked = list({ locked: true });
  assertEquals(shownThemeId(locked, "day"), "night");
  assertEquals(shownThemeId(locked, STOCK_THEME), "night");
});

Deno.test("pickerOptions: Swamp plus each theme, none when locked or themeless", () => {
  assertEquals(pickerOptions(list()).map((o) => o.label), [
    "Swamp",
    "Day game",
    "Night game",
  ]);
  assertEquals(pickerOptions(list({ locked: true })), []);
  assertEquals(pickerOptions(list({ themes: [], default: null })), []);
});

Deno.test("mergeThemes: a theme the server reports broken keeps its last good copy, and stays the default", () => {
  const before = list();
  const after = mergeThemes(before, {
    themes: [{ id: "day", label: "Day game", theme: "day-v2" }],
    default: null,
    locked: false,
    errors: [{ id: "night", error: "bad colour" }],
  });
  assertEquals(after.themes.map((t) => t.theme), ["day-v2", "night-v1"]);
  assertEquals(after.default, "night");
});

Deno.test("mergeThemes: a theme removed without an error is gone", () => {
  const after = mergeThemes(list(), {
    themes: [{ id: "day", label: "Day game", theme: "day-v1" }],
    default: "day",
    locked: false,
    errors: [],
  });
  assertEquals(after.themes.map((t) => t.id), ["day"]);
  assertEquals(after.default, "day");
});
