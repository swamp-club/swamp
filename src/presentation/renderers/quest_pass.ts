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

import type { EventHandlers, QuestPassEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import type {
  GenesisChallenge,
  GenesisPass,
} from "../../domain/quest/genesis_pass.ts";
import { bold, dim, green, stripAnsiCode, yellow } from "@std/fmt/colors";

// ─── LOG LAYOUT (Design: "The Legible Ladder", swamp-club seasons/genesis) ───
// Renders the linear Genesis pass from a `GenesisPass`. The data shape is
// stable, so this body is the only thing that changes when the design does.

/** Content width the right-aligned columns snap to. */
const WIDTH = 60;
/** Column where the XP bars begin, so both bars align. */
const BAR_COL = 30;

/** The one-line "what is this" — the first line and the command's help text. */
export const QUEST_TAGLINE = "What treasures are there yet to discover?";

/** Banner shown when every deed is done. */
const GAME_OVER = [
  " ██████╗  █████╗ ███╗   ███╗███████╗     ██████╗ ██╗   ██╗███████╗██████╗",
  "██╔════╝ ██╔══██╗████╗ ████║██╔════╝    ██╔═══██╗██║   ██║██╔════╝██╔══██╗",
  "██║  ███╗███████║██╔████╔██║█████╗      ██║   ██║██║   ██║█████╗  ██████╔╝",
  "██║   ██║██╔══██║██║╚██╔╝██║██╔══╝      ██║   ██║╚██╗ ██╔╝██╔══╝  ██╔══██╗",
  "╚██████╔╝██║  ██║██║ ╚═╝ ██║███████╗    ╚██████╔╝ ╚████╔╝ ███████╗██║  ██║",
  " ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝     ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═╝",
].join("\n");

/** Warm amber-gold — the Genesis campaign accent. */
const gold = (s: string): string => yellow(s);

/** Visible width, ignoring ANSI color codes. */
function vlen(s: string): number {
  return stripAnsiCode(s).length;
}

function padEnd(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - vlen(s)));
}

function padStart(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - vlen(s))) + s;
}

/** A left segment and a right segment pushed to opposite edges of `width`. */
function spread(left: string, right: string, width = WIDTH): string {
  const gap = Math.max(1, width - vlen(left) - vlen(right));
  return left + " ".repeat(gap) + right;
}

/** Thousands-separated integer, e.g. 1980 → "1,980". */
function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** A gold fill / dim-hatch progress bar. */
function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return gold("█".repeat(filled)) + dim("░".repeat(width - filled));
}

/** Name-column width for a set of meter rows: fits the longest name, +2 gap. */
function nameCol(rows: { name: string }[]): number {
  return Math.max(14, ...rows.map((r) => vlen(r.name))) + 2;
}

/** The `+50XP` reward tag for a deed, in gold. */
function xpTag(xp: number): string {
  return gold(`+${num(xp)}XP`);
}

/** Width of the `+XP` column for a set of deeds: fits the widest tag, +2 gap. */
function xpCol(rows: { xp: number }[]): number {
  return rows.length === 0
    ? 0
    : Math.max(...rows.map((r) => vlen(xpTag(r.xp)))) + 2;
}

/** How many deeds the default (non-`--full`) view surfaces. */
const NEXT_UP = 4;

/** Progress toward completion, 0..1. Firsts are all-or-nothing. */
function fraction(c: GenesisChallenge): number {
  if (c.kind === "counter") return c.progress / (c.target ?? 1);
  return c.done ? 1 : 0;
}

/**
 * One deed row: name, +XP tag, then a track column. Counters show a progress
 * meter + count; firsts share that same column — a full bar + `✓` when done, an
 * empty bar + `·` when not — so an all-firsts block reads as intentional rows
 * rather than a column of orphaned markers floating in whitespace.
 */
function deedRow(c: GenesisChallenge, col: number, xpc: number): string {
  const head = `    ${padEnd(c.name, col)}${padEnd(xpTag(c.xp), xpc)}`;
  if (c.kind === "counter") {
    const target = c.target ?? 1;
    return `${head}${bar(c.progress / target, 10)}  ${
      padStart(`${c.progress}/${target}`, 6)
    }`;
  }
  return `${head}${bar(c.done ? 1 : 0, 10)}  ${
    padStart(c.done ? green("✓") : dim("·"), 6)
  }`;
}

/**
 * The deeds block — the XP-earning plays. Default surfaces the handful you're
 * closest to landing, headed by the reward they climb toward. `--full` lists
 * every deed on the pass, completed ones included.
 */
function renderDeeds(
  push: (s?: string) => void,
  pass: GenesisPass,
  full: boolean,
): void {
  if (full) {
    const counters = pass.challenges.filter((c) => c.kind === "counter");
    const firsts = pass.challenges.filter((c) => c.kind === "first");
    const all = [...counters, ...firsts];
    const col = nameCol(all);
    const xpc = xpCol(all);
    push(`${gold("all deeds")}${dim(" — every deed on the pass")}`);
    for (const c of all) push(deedRow(c, col, xpc));
    push();
    return;
  }

  const incomplete = pass.challenges.filter((c) => !c.done);
  if (incomplete.length === 0) {
    push("Congratulations! You've completed your quest.");
    push();
    push(gold(GAME_OVER));
    push();
    return;
  }
  const plays = [...incomplete]
    .sort((a, b) => fraction(b) - fraction(a))
    .slice(0, NEXT_UP);
  const col = nameCol(plays);
  const xpc = xpCol(plays);
  push(
    pass.nextTier
      ? `Path to ${bold(pass.nextTier.name)}`
      : `Path to ${bold("GENESIS")}`,
  );
  for (const c of plays) push(deedRow(c, col, xpc));
  push();
}

/**
 * The Genesis pass — one layout for everyone. The only thing that differs
 * between an authenticated pass and the ghost (device-local, unclaimed) read is
 * the footer: the ghost gets the login conversion line, the authed user gets
 * the "claim on the web" reminder.
 */
function renderPassLog(pass: GenesisPass, full: boolean, ghost: boolean): void {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  // First line — the simple "what is this", same as the command's help text.
  // Suppressed once complete; the GAME OVER banner below carries that state.
  push();
  if (!pass.challenges.every((c) => c.done)) {
    push(QUEST_TAGLINE.replace("treasures", gold("treasures")));
    push();
  }

  // Ladder — current tier, ladder bar, headline XP.
  const tierLeft = padEnd(
    bold(`TIER ${pass.currentTier} / ${pass.totalTiers}`),
    BAR_COL,
  );
  push(spread(
    tierLeft + bar(pass.ladderFraction, 10),
    bold(`${num(pass.passXp)} XP`),
  ));

  // Next tier — progress into it.
  if (pass.nextTier) {
    const nextLeft = padEnd(
      `${dim("next:")} ${pass.nextTier.name} (T${pass.nextTier.n})`,
      BAR_COL,
    );
    const frac = pass.xpForNext > 0 ? pass.xpIntoCurrent / pass.xpForNext : 0;
    push(spread(
      nextLeft + bar(frac, 10),
      `${num(pass.xpIntoCurrent)} / ${num(pass.xpForNext)}`,
    ));
  }
  push();

  renderDeeds(push, pass, full);

  // Footer — the only authed/ghost divergence.
  if (ghost) {
    const bridgeXp = pass.challenges.find((c) => c.bridge)?.xp ?? 200;
    push(
      `login to claim your rewards and get ${gold(`+${bridgeXp}XP`)}. ${
        bold("swamp auth login")
      }`,
    );
  } else {
    push(
      dim("claim your rewards on https://swamp-club.com"),
    );
  }
  push();

  writeOutput(lines.join("\n"));
}
// ─── END LOG LAYOUT ─────────────────────────────────────────────────────────

class LogQuestPassRenderer implements Renderer<QuestPassEvent> {
  constructor(private readonly full: boolean) {}

  handlers(): EventHandlers<QuestPassEvent> {
    return {
      completed: (e) => renderPassLog(e.data.pass, this.full, e.data.ghost),
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonQuestPassRenderer implements Renderer<QuestPassEvent> {
  handlers(): EventHandlers<QuestPassEvent> {
    return {
      completed: (e) => {
        console.log(JSON.stringify(e.data.pass, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createQuestPassRenderer(
  mode: OutputMode,
  full = false,
): Renderer<QuestPassEvent> {
  switch (mode) {
    case "json":
      return new JsonQuestPassRenderer();
    case "log":
      return new LogQuestPassRenderer(full);
  }
}
