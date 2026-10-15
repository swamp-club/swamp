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
import { stripAnsiCode } from "@std/fmt/colors";
import { SWAMP_PALETTE, swampColor, swampColorDepth } from "./swamp_colors.ts";

function env(vars: Record<string, string>) {
  return (name: string): string | undefined => vars[name];
}

Deno.test("SWAMP_PALETTE: carries the swamp-club website colors", () => {
  assertEquals(SWAMP_PALETTE.magenta.rgb, 0xff00ff);
  assertEquals(SWAMP_PALETTE.cyan.rgb, 0x22d3ee);
  assertEquals(SWAMP_PALETTE.green.rgb, 0x4ade80);
  assertEquals(SWAMP_PALETTE.muted.rgb, 0x9ca3af);
  assertEquals(SWAMP_PALETTE.neon.rgb, 0x39ff14);
});

Deno.test("SWAMP_PALETTE: each xterm-256 fallback is the nearest cube or gray color", () => {
  assertEquals(SWAMP_PALETTE.magenta.ansi256, 201);
  assertEquals(SWAMP_PALETTE.cyan.ansi256, 45);
  assertEquals(SWAMP_PALETTE.green.ansi256, 78);
  assertEquals(SWAMP_PALETTE.muted.ansi256, 248);
  assertEquals(SWAMP_PALETTE.neon.ansi256, 82);
});

Deno.test("swampColorDepth: COLORTERM truecolor or 24bit means 24-bit color", () => {
  assertEquals(swampColorDepth(env({ COLORTERM: "truecolor" })), "truecolor");
  assertEquals(swampColorDepth(env({ COLORTERM: "24bit" })), "truecolor");
  assertEquals(swampColorDepth(env({ COLORTERM: "TrueColor" })), "truecolor");
});

Deno.test("swampColorDepth: Windows Terminal means 24-bit color", () => {
  assertEquals(swampColorDepth(env({ WT_SESSION: "abc" })), "truecolor");
});

Deno.test("swampColorDepth: anything else falls back to xterm-256", () => {
  assertEquals(swampColorDepth(env({})), "256");
  assertEquals(swampColorDepth(env({ COLORTERM: "1" })), "256");
});

Deno.test("swampColor: leaves the text itself unchanged at either depth", () => {
  assertEquals(stripAnsiCode(swampColor("magenta", "━━", "truecolor")), "━━");
  assertEquals(stripAnsiCode(swampColor("muted", "──", "256")), "──");
});
