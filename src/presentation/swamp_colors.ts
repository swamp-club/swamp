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

import { rgb24, rgb8 } from "@std/fmt/colors";

/**
 * The swamp colors, taken from the swamp-club website. For now they are used
 * only by live progress (the spinner and the `swamp update` download bar);
 * other output keeps the plain colors of the terminal-output design system.
 */
export type SwampColor = "magenta" | "cyan" | "green" | "muted" | "neon";

/** A color as 24-bit RGB and as its nearest xterm-256 index. */
export interface SwampColorValue {
  readonly rgb: number;
  readonly ansi256: number;
}

export const SWAMP_PALETTE: Readonly<Record<SwampColor, SwampColorValue>> = {
  /** #ff00ff: the filled part of a progress bar. */
  magenta: { rgb: 0xff00ff, ansi256: 201 },
  /** #22d3ee: the spinner frame and the percentage. */
  cyan: { rgb: 0x22d3ee, ansi256: 45 },
  /** #4ade80 (green-400): success. */
  green: { rgb: 0x4ade80, ansi256: 78 },
  /** #9ca3af (gray-400, the site's hud-muted): secondary text, empty bar. */
  muted: { rgb: 0x9ca3af, ansi256: 248 },
  /** #39ff14: the site's neon accent, spare for now. */
  neon: { rgb: 0x39ff14, ansi256: 82 },
};

/** How many colors the terminal can show. */
export type ColorDepth = "truecolor" | "256";

/**
 * Reads the color depth from the environment: 24-bit when `COLORTERM` says
 * so or the terminal is Windows Terminal (which supports it but does not set
 * `COLORTERM`), xterm-256 otherwise.
 */
export function swampColorDepth(
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): ColorDepth {
  const colorTerm = readEnv("COLORTERM")?.toLowerCase();
  if (colorTerm === "truecolor" || colorTerm === "24bit") return "truecolor";
  if (readEnv("WT_SESSION") !== undefined) return "truecolor";
  return "256";
}

/**
 * Colors `text` with a swamp color. Goes through `@std/fmt/colors`, so the
 * color policy (`NO_COLOR`, `--no-color`, piped stdout) leaves it plain.
 */
export function swampColor(
  color: SwampColor,
  text: string,
  depth: ColorDepth = swampColorDepth(),
): string {
  const value = SWAMP_PALETTE[color];
  return depth === "truecolor"
    ? rgb24(text, value.rgb)
    : rgb8(text, value.ansi256);
}
