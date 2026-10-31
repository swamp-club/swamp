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

import { assert, assertEquals } from "@std/assert";
import { agentSessionSummary } from "../../../../src/domain/agent_sessions/session_record.ts";
import { fixtureSessions } from "../views/agent_sessions/fixtures.ts";
import {
  callBar,
  callKey,
  compressIdle,
  filterTone,
  labelMix,
  listTotals,
  matchingCalls,
  mergedFindings,
  passes,
  sessionTiles,
  spanTree,
  STRIP_GAP_MS,
  subagentLinks,
  swampShare,
  turnScale,
} from "./agent_session_view.ts";

const [edits, long, child, headless] = fixtureSessions();

Deno.test("swampShare: swamp over swamp plus bypass, neutral not counted", () => {
  assertEquals(swampShare({ swamp: 3, bypass: 1 }), 0.75);
  assertEquals(swampShare({ swamp: 0, bypass: 0 }), null);
});

Deno.test("labelMix: shares of all calls, zero for an empty session", () => {
  const mix = labelMix({
    swamp: 1,
    bypass: 1,
    neutral: 1,
    unlabeled: 1,
    calls: 4,
  });
  assertEquals(mix, {
    swamp: 0.25,
    bypass: 0.25,
    neutral: 0.25,
    unlabeled: 0.25,
  });
  assertEquals(
    labelMix({ swamp: 0, bypass: 0, neutral: 0, unlabeled: 0, calls: 0 }).swamp,
    0,
  );
});

Deno.test("sessionTiles: counts the session's own calls and groups bypasses", () => {
  const tiles = sessionTiles(edits);
  assertEquals(tiles.calls, 32);
  assertEquals(
    tiles.counts.swamp + tiles.counts.bypass + tiles.counts.neutral +
      tiles.counts.unlabeled,
    32,
  );
  assertEquals(tiles.failed, 3);
  assertEquals(tiles.firstFailedTurn, 2);
  assertEquals(tiles.bypassCategories[0][0], "hand-edited definition");
  assert(tiles.activeMs < tiles.wallMs, "idle time makes wall clock longer");
  assert(tiles.cacheShare !== null && tiles.cacheShare > 0.5);
});

Deno.test("listTotals: adds up summaries and leaves out sessions without one", () => {
  const summaries = [edits, long, headless].map(agentSessionSummary);
  const totals = listTotals([...summaries, undefined]);
  assertEquals(totals.sessions, 4);
  assertEquals(totals.unsummarized, 1);
  assertEquals(totals.headless, 1);
  assertEquals(totals.calls, 32 + 169 + 29);
  assertEquals(
    totals.counts.swamp + totals.counts.bypass + totals.counts.neutral +
      totals.counts.unlabeled,
    totals.calls,
  );
  assertEquals(
    totals.failed,
    summaries.reduce((n, s) => n + s.failedCalls, 0),
  );
  assertEquals(totals.share, swampShare(totals.counts));
  assert(totals.sessionsToReview <= 3);
});

Deno.test("listTotals: no sessions gives no shares", () => {
  const totals = listTotals([]);
  assertEquals(totals.share, null);
  assertEquals(totals.cacheShare, null);
  assertEquals(totals.calls, 0);
});

Deno.test("filterTone: a label, failed, and a finding's severity", () => {
  assertEquals(filterTone({ kind: "all" }), "all");
  assertEquals(filterTone({ kind: "label", label: "bypass" }), "l-bypass");
  assertEquals(filterTone({ kind: "failed" }), "failed");
  assertEquals(
    filterTone({ kind: "calls", calls: new Set(), severity: "high" }),
    "sev-high",
  );
  assertEquals(filterTone({ kind: "calls", calls: new Set() }), "sev-info");
});

Deno.test("compressIdle: removes idle time and keeps each turn's length", () => {
  const { segments, total } = compressIdle(edits.turns);
  assertEquals(segments.map((s) => s.n), [1, 2, 3, 4, 5]);
  for (let i = 1; i < segments.length; i++) {
    assert(segments[i].from - segments[i - 1].to <= STRIP_GAP_MS);
  }
  assert(segments[4].idleBefore >= 20 * 60 * 1000);
  assert(total < sessionTiles(edits).wallMs);
});

Deno.test("turnScale and callBar: a call sits inside its turn's own width", () => {
  const turn = long.turns[4];
  const scale = turnScale(turn);
  for (const call of turn.calls) {
    const bar = callBar(call, scale);
    assert(bar.left >= 0 && bar.width >= 0 && bar.left + bar.width <= 1 + 1e-9);
  }
  // A negative duration draws as zero.
  assertEquals(
    callBar({ start: 50, end: 10 }, { start: 0, length: 100 }).width,
    0,
  );
  assertEquals(turnScale({ ...turn, calls: [], end: turn.start }).length, 1);
});

Deno.test("spanTree: nests spans by depth", () => {
  const roots = spanTree([
    { name: "swamp.cli", start: 0, duration: 10, depth: 0, error: false },
    { name: "startup", start: 0, duration: 2, depth: 1, error: false },
    { name: "run", start: 2, duration: 6, depth: 1, error: true },
    { name: "write", start: 3, duration: 1, depth: 2, error: false },
    { name: "teardown", start: 8, duration: 2, depth: 1, error: false },
  ]);
  assertEquals(roots.length, 1);
  assertEquals(roots[0].children.map((c) => c.name), [
    "startup",
    "run",
    "teardown",
  ]);
  assertEquals(roots[0].children[1].children[0].name, "write");
});

Deno.test("subagentLinks: maps the starting call to its child session", () => {
  const links = [...subagentLinks(long)];
  assertEquals(links.length, 1);
  assertEquals(links[0][1], child.id);
  assertEquals(subagentLinks(headless).size, 0);
});

Deno.test("mergedFindings: the subagent's findings join the parent's, most severe first", () => {
  const shown = mergedFindings(long, [child]);
  assertEquals(shown.map((f) => f.finding.severity), ["medium", "low", "info"]);
  const fromChild = shown.find((f) => f.fromSubagent);
  assertEquals(fromChild?.sessionId, child.id);
  // Show calls reaches the subagent's own calls.
  const keys = matchingCalls({ kind: "calls", calls: fromChild!.calls }, [
    long,
    child,
  ]);
  assertEquals(keys, fromChild!.calls);
  assert([...keys].every((k) => k.startsWith(`${child.id}/`)));
});

Deno.test("passes: label, failed and call-set filters", () => {
  const call = { id: "c1", label: "bypass" as const, ok: false };
  assert(passes({ kind: "all" }, "s", call));
  assert(passes({ kind: "label", label: "bypass" }, "s", call));
  assert(!passes({ kind: "label", label: "swamp" }, "s", call));
  assert(passes({ kind: "failed" }, "s", call));
  assert(
    passes({ kind: "calls", calls: new Set([callKey("s", "c1")]) }, "s", call),
  );
  assert(
    !passes({ kind: "calls", calls: new Set([callKey("t", "c1")]) }, "s", call),
  );
});
