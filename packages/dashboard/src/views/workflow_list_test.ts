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
  aggregateRuns,
  formatPassRate,
  partitionByActivity,
  resolveSort,
  type RunStats,
  sortWorkflows,
  takeAcrossGroups,
} from "./workflow_list.ts";

const stats: Record<string, RunStats> = {
  alpha: {
    runs: 10,
    succeeded: 9,
    failed: 1,
    durationMs: 5_000,
    lastStartedAt: "2026-10-10T00:00:00Z",
  },
  bravo: {
    runs: 2,
    succeeded: 0,
    failed: 2,
    durationMs: 90_000,
    lastStartedAt: "2026-10-12T00:00:00Z",
  },
  charlie: {
    runs: 10,
    succeeded: 10,
    failed: 0,
    durationMs: 1_000,
    lastStartedAt: "2026-10-11T00:00:00Z",
  },
  idle: { runs: 0, succeeded: 0, failed: 0, durationMs: 0 },
};

const items = [
  { name: "zulu" }, // no summary at all
  { name: "idle" },
  { name: "alpha" },
  { name: "charlie" },
  { name: "bravo" },
];
const statsOf = (w: { name: string }) => stats[w.name];
const names = (list: Array<{ name: string }>) => list.map((w) => w.name);

Deno.test("resolveSort: auto is best match while searching, else recent", () => {
  assertEquals(resolveSort("auto", ""), "recent");
  assertEquals(resolveSort("auto", "  "), "recent");
  assertEquals(resolveSort("auto", "dep"), "relevance");
  assertEquals(resolveSort("name", "dep"), "name");
});

Deno.test("sortWorkflows: recent puts newest first and never-run last by name", () => {
  assertEquals(names(sortWorkflows(items, "recent", statsOf)), [
    "bravo",
    "charlie",
    "alpha",
    "idle",
    "zulu",
  ]);
});

Deno.test("sortWorkflows: metric sorts tie-break on recency and keep never-run last", () => {
  assertEquals(names(sortWorkflows(items, "runs", statsOf)), [
    "charlie",
    "alpha",
    "bravo",
    "idle",
    "zulu",
  ]);
  assertEquals(names(sortWorkflows(items, "failures", statsOf)), [
    "bravo",
    "alpha",
    "charlie",
    "idle",
    "zulu",
  ]);
  assertEquals(names(sortWorkflows(items, "time", statsOf)), [
    "bravo",
    "alpha",
    "charlie",
    "idle",
    "zulu",
  ]);
});

Deno.test("sortWorkflows: name is alphabetical; relevance keeps input order", () => {
  assertEquals(names(sortWorkflows(items, "name", statsOf)), [
    "alpha",
    "bravo",
    "charlie",
    "idle",
    "zulu",
  ]);
  assertEquals(names(sortWorkflows(items, "relevance", statsOf)), names(items));
});

Deno.test("sortWorkflows: does not mutate its input", () => {
  const input = [...items];
  sortWorkflows(input, "name", statsOf);
  assertEquals(names(input), names(items));
});

Deno.test("partitionByActivity: zero runs and missing summaries never ran", () => {
  const { ran, neverRan } = partitionByActivity(items, statsOf);
  assertEquals(names(ran), ["alpha", "charlie", "bravo"]);
  assertEquals(names(neverRan), ["zulu", "idle"]);
});

Deno.test("takeAcrossGroups: limits across groups and drops emptied groups", () => {
  const groups = [
    { key: "a", label: "a", items: [1, 2, 3] },
    { key: "b", label: "b", items: [4, 5] },
    { key: "c", label: "c", items: [6] },
  ];
  assertEquals(takeAcrossGroups(groups, 4), {
    groups: [
      { key: "a", label: "a", items: [1, 2, 3] },
      { key: "b", label: "b", items: [4] },
    ],
    shown: 4,
    total: 6,
  });
  assertEquals(takeAcrossGroups(groups, 100).shown, 6);
  assertEquals(takeAcrossGroups(groups, 0), { groups: [], shown: 0, total: 6 });
});

Deno.test("aggregateRuns: sums runs and failures, pass rate over finished runs", () => {
  assertEquals(aggregateRuns(items, statsOf), {
    runs: 22,
    failed: 3,
    passRate: 19 / 22,
  });
  assertEquals(aggregateRuns([{ name: "idle" }], statsOf).passRate, null);
});

Deno.test("formatPassRate: never rounds to 100% or 0% falsely", () => {
  assertEquals(formatPassRate(1), "100%");
  assertEquals(formatPassRate(0.999), ">99%");
  assertEquals(formatPassRate(0.864), "86%");
  assertEquals(formatPassRate(0.001), "<1%");
  assertEquals(formatPassRate(0), "0%");
});
