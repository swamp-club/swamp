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

import { isAbsolute as isPosixAbsolute } from "@std/path/posix";
import { isAbsolute as isWindowsAbsolute } from "@std/path/windows";
import { markErrorPaths, UserError } from "../errors.ts";

export const SWAMPIFY_KICKOFF_TITLE =
  "Swampify kick-off: start from your past sessions";

/** the line the swampify skill recognises; its wording is pinned on both sides */
export const SWAMPIFY_KICKOFF_MARKER = "<!-- swampify kick-off v1 -->";

export const SWAMPIFY_KICKOFF_WINDOW_DEFAULT = 30;
export const SWAMPIFY_KICKOFF_WINDOW_MAX = 365;
export const SWAMPIFY_KICKOFF_EXCLUDE_MAX = 20;
export const SWAMPIFY_KICKOFF_PATH_MAX = 512;

export type SwampifyKickoffHarness = "claude" | "codex";

export const SWAMPIFY_KICKOFF_HARNESSES: readonly SwampifyKickoffHarness[] = [
  "claude",
  "codex",
];

// Paths reach the brief, and from there the agent's shell inside single
// quotes, so anything that could end the quoting, the fence or the line is
// refused rather than escaped.
const UNSAFE_PATH_CHARS = new Set(["'", '"', "`", "$", "<", ">"]);

function hasUnsafeChar(path: string): boolean {
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029 || UNSAFE_PATH_CHARS.has(ch)) {
      return true;
    }
  }
  return false;
}

function isAcceptedPath(path: string, os: string): boolean {
  if (path === "~" || path.startsWith("~/")) return true;
  if (os === "windows") {
    return path.startsWith("~\\") || isWindowsAbsolute(path);
  }
  return isPosixAbsolute(path);
}

/**
 * The window and scope of a Swampify kick-off; the only user input that
 * reaches its task text.
 */
export class SwampifyKickoff {
  private constructor(
    readonly windowDays: number,
    readonly exclude: readonly string[],
  ) {}

  static create(
    input: { windowDays: number; exclude?: readonly string[] },
    os: string = Deno.build.os,
  ): SwampifyKickoff {
    const { windowDays } = input;
    if (
      !Number.isInteger(windowDays) || windowDays < 1 ||
      windowDays > SWAMPIFY_KICKOFF_WINDOW_MAX
    ) {
      throw new UserError(
        `Choose a window of 1 to ${SWAMPIFY_KICKOFF_WINDOW_MAX} days.`,
        "invalid_window",
      );
    }
    const exclude: string[] = [];
    for (const raw of input.exclude ?? []) {
      const path = raw.trim();
      if (path === "" || exclude.includes(path)) continue;
      if (Array.from(path).length > SWAMPIFY_KICKOFF_PATH_MAX) {
        throw new UserError(
          `An excluded path is longer than ${SWAMPIFY_KICKOFF_PATH_MAX} characters.`,
          "invalid_exclude",
        );
      }
      if (hasUnsafeChar(path)) {
        throw markErrorPaths(
          new UserError(
            `Excluded paths can't contain quotes, backticks, $, < or >, or control characters: ${path}`,
            "invalid_exclude",
          ),
          [path],
        );
      }
      if (!isAcceptedPath(path, os)) {
        throw markErrorPaths(
          new UserError(
            `Excluded paths must be absolute or start with ~: ${path}`,
            "invalid_exclude",
          ),
          [path],
        );
      }
      exclude.push(path);
    }
    if (exclude.length > SWAMPIFY_KICKOFF_EXCLUDE_MAX) {
      throw new UserError(
        `Exclude at most ${SWAMPIFY_KICKOFF_EXCLUDE_MAX} paths.`,
        "invalid_exclude",
      );
    }
    return new SwampifyKickoff(windowDays, exclude);
  }

  /** the task text; built only from this constant and the window and scope */
  render(): string {
    const excluded = this.exclude.length === 0
      ? ["Excluded paths: none"]
      : ["Excluded paths:", "", "```json", JSON.stringify(this.exclude), "```"];
    return [
      SWAMPIFY_KICKOFF_TITLE,
      SWAMPIFY_KICKOFF_MARKER,
      "",
      `Window: last ${this.windowDays} days`,
      "Scope: every session on this machine",
      ...excluded,
      "",
      "1. Run `swamp extension pull @swamp/agent-sessions`. It writes into `.claude/skills` and `.agents/skills`; if a sandbox refuses that, ask the user to let the command run outside it.",
      "2. Run `swamp behavior create @swamp/agent-sessions swampify`, unless a behavior of that type already exists; then use that one.",
      "3. Follow the swampify skill from its first state, with the window and scope above. If the skill isn't available in this session yet, read its SKILL.md where the pull installed it: `.claude/skills/swampify/SKILL.md` for Claude Code, `.agents/skills/swampify/SKILL.md` for Codex.",
      "",
      "The user read what will be read and stored on the swamp start page. Still give the skill's disclosure and wait for the user to agree before anything is read; skip only its window and scope questions.",
    ].join("\n");
  }
}
