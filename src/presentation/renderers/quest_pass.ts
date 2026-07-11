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
  GenesisPass,
  GenesisTier,
} from "../../domain/quest/genesis_pass.ts";
import {
  bold,
  dim,
  green,
  magenta,
  stripAnsiCode,
  yellow,
} from "@std/fmt/colors";

// ─── LOG LAYOUT (Design: "The Legible Ladder", swamp-club seasons/genesis) ───
// Renders the linear Genesis pass from a `GenesisPass`. The data shape is
// stable, so this body is the only thing that changes when the design does.

/** Content width the right-aligned columns snap to. */
const WIDTH = 60;
/** Column where the XP bars begin, so both bars align. */
const BAR_COL = 30;

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

/** "Tier n — Free  +  Premium (premium)" for a claimed/claimable tier. */
function rewardLabel(t: GenesisTier, showPremium: boolean): string {
  const free = `Tier ${t.n} — ${t.free.name}`;
  if (!showPremium) return free;
  return `${free}  ${dim("+")}  ${magenta(t.premium.name)} ${dim("(premium)")}`;
}

function renderPassLog(pass: GenesisPass): void {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  // Header — "swamp quest · GENESIS" left, operative right.
  push();
  push(spread(
    `${bold("swamp quest")} ${dim("·")} ${bold(gold("GENESIS"))}`,
    bold(pass.username),
  ));
  push();

  // Ladder — current tier + reward name, ladder bar, headline XP.
  const currentReward = pass.currentTier >= 1
    ? pass.tiers[pass.currentTier - 1].free.name
    : "—";
  const tierLeft = padEnd(
    `${
      bold(`TIER ${pass.currentTier} / ${pass.totalTiers}`)
    }  ${currentReward}`,
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
  } else {
    push(gold("the capstone is claimed — GENESIS complete"));
  }
  push();

  // Claimed — the highest tier already banked to lifetime.
  let claimed: GenesisTier | undefined;
  for (const t of pass.tiers) {
    if (t.free.claimState === "claimed") claimed = t;
  }
  if (claimed) {
    const withPrem = claimed.premium.claimState === "claimed";
    push(
      `${padEnd(green("✓ CLAIMED"), 12)} ${rewardLabel(claimed, withPrem)}`,
    );
    push(
      `${" ".repeat(13)}${gold("→")} ${
        dim("banked to lifetime · un-re-earnable")
      }`,
    );
  }

  // Claimable — reached but not yet claimed; the CLI is read-only, claim on web.
  if (pass.claimableTier !== null) {
    const t = pass.tiers[pass.claimableTier - 1];
    if (claimed) push();
    push(
      `${padEnd(gold("◆ CLAIMABLE"), 12)} ${rewardLabel(t, pass.hasPremium)}`,
    );
    push(`${" ".repeat(13)}${gold("→")} ${dim("claim on swamp-club.com")}`);
  }
  push();

  // Deeds left — the in-progress counters that move the bar.
  const deeds = pass.challenges.filter(
    (c) => c.kind === "counter" && !c.done && c.progress > 0,
  );
  if (deeds.length > 0) {
    push(`${gold("in progress")}${dim(" — the deeds left")}`);
    for (const c of deeds) {
      const target = c.target ?? 1;
      const meter = `    ${padEnd(c.name, 14)}${bar(c.progress / target, 10)}`;
      const counts = padStart(`${c.progress}/${target}`, 6);
      push(`${meter}  ${counts}   ${gold(`+${c.xp}`)}`);
    }
    push();
  }

  // Footer — the loop: read here, claim on the web.
  push(
    dim("run `swamp quest` any time · claim your rewards on swamp-club.com"),
  );
  push();

  writeOutput(lines.join("\n"));
}
/** The ghost variant — unauthenticated, every reward UNCLAIMED, the login ache. */
function renderGhostLog(pass: GenesisPass): void {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  // Header — "(unclaimed)" instead of an operative name.
  push();
  push(spread(
    `${bold("swamp quest")} ${dim("·")} ${bold(gold("GENESIS"))}`,
    dim("(unclaimed)"),
  ));
  push();

  // Ladder — the real accrued XP; it just isn't claimed to an account yet.
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

  // The ache — everything earned, nothing keepable until the account is claimed.
  const bridgeXp = pass.challenges.find((c) => c.bridge)?.xp ?? 200;
  push(
    `${dim("◇")} every reward reads ${bold("UNCLAIMED")} ${
      dim("— you earned it, you can't keep it yet")
    }`,
  );
  push(
    `${gold("◆")} log in to claim everything ${gold("→")} ${
      bold("swamp auth login")
    }  ${gold(`(+${bridgeXp})`)}`,
  );
  push();

  // Deeds recorded — completed firsts as chips, counters with bars.
  push(dim("deeds recorded"));
  const firsts = pass.challenges.filter((c) => c.kind === "first" && c.done);
  for (let i = 0; i < firsts.length; i += 3) {
    const chips = firsts.slice(i, i + 3)
      .map((c) => `${c.name} ${green("✓")}`);
    push(`    ${chips.map((c) => padEnd(c, 20)).join("")}`);
  }
  const counters = pass.challenges.filter(
    (c) => c.kind === "counter" && !c.done && c.progress > 0,
  );
  for (const c of counters) {
    const target = c.target ?? 1;
    const meter = `    ${padEnd(c.name, 14)}${bar(c.progress / target, 10)}`;
    push(`${meter}  ${padStart(`${c.progress}/${target}`, 6)}`);
  }
  if (firsts.length === 0 && counters.length === 0) {
    push(`    ${dim("nothing yet — run `swamp model create` to begin")}`);
  }
  push();

  // Footer — the conversion line.
  push(dim("the record is real. claim your badge by logging in."));
  push();

  writeOutput(lines.join("\n"));
}
// ─── END LOG LAYOUT ─────────────────────────────────────────────────────────

class LogQuestPassRenderer implements Renderer<QuestPassEvent> {
  handlers(): EventHandlers<QuestPassEvent> {
    return {
      completed: (e) =>
        e.data.ghost ? renderGhostLog(e.data.pass) : renderPassLog(e.data.pass),
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
): Renderer<QuestPassEvent> {
  switch (mode) {
    case "json":
      return new JsonQuestPassRenderer();
    case "log":
      return new LogQuestPassRenderer();
  }
}
