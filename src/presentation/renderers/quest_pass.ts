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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type { QuestPassEvent } from "../../libswamp/quest/pass.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import type {
  GenesisChallenge,
  GenesisPass,
} from "../../domain/quest/genesis_pass.ts";
import { bold, dim, green, stripAnsiCode, yellow } from "@std/fmt/colors";

// the data shape is stable, so this body is the only thing that changes when
// the design does

const WIDTH = 60;
const BAR_COL = 30;

export const QUEST_TAGLINE = "What treasures are there yet to discover?";

const GAME_OVER = [
  " ██████╗  █████╗ ███╗   ███╗███████╗     ██████╗ ██╗   ██╗███████╗██████╗",
  "██╔════╝ ██╔══██╗████╗ ████║██╔════╝    ██╔═══██╗██║   ██║██╔════╝██╔══██╗",
  "██║  ███╗███████║██╔████╔██║█████╗      ██║   ██║██║   ██║█████╗  ██████╔╝",
  "██║   ██║██╔══██║██║╚██╔╝██║██╔══╝      ██║   ██║╚██╗ ██╔╝██╔══╝  ██╔══██╗",
  "╚██████╔╝██║  ██║██║ ╚═╝ ██║███████╗    ╚██████╔╝ ╚████╔╝ ███████╗██║  ██║",
  " ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝     ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═╝",
].join("\n");

const gold = (s: string): string => yellow(s);

function vlen(s: string): number {
  return stripAnsiCode(s).length;
}

function padEnd(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - vlen(s)));
}

function padStart(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - vlen(s))) + s;
}

function spread(left: string, right: string, width = WIDTH): string {
  const gap = Math.max(1, width - vlen(left) - vlen(right));
  return left + " ".repeat(gap) + right;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return gold("█".repeat(filled)) + dim("░".repeat(width - filled));
}

function nameCol(rows: { name: string }[]): number {
  return Math.max(14, ...rows.map((r) => vlen(r.name))) + 2;
}

function xpTag(xp: number): string {
  return gold(`+${num(xp)}XP`);
}

function xpCol(rows: { xp: number }[]): number {
  return rows.length === 0
    ? 0
    : Math.max(...rows.map((r) => vlen(xpTag(r.xp)))) + 2;
}

const NEXT_UP = 4;

function fraction(c: GenesisChallenge): number {
  if (c.kind === "counter") return c.progress / (c.target ?? 1);
  return c.done ? 1 : 0;
}

/**
 * firsts share the counter column, a full bar and ✓ when done and an empty bar
 * and · when not, so an all-firsts block reads as rows rather than orphaned
 * markers
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

function renderPassLog(pass: GenesisPass, full: boolean, ghost: boolean): void {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push();
  if (!pass.challenges.every((c) => c.done)) {
    push(QUEST_TAGLINE.replace("treasures", gold("treasures")));
    push();
  }

  const tierLeft = padEnd(
    bold(`TIER ${pass.currentTier} / ${pass.totalTiers}`),
    BAR_COL,
  );
  push(spread(
    tierLeft + bar(pass.ladderFraction, 10),
    bold(`${num(pass.passXp)} XP`),
  ));

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
