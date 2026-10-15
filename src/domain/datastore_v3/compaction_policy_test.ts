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
  compactionBound,
  compactionTarget,
  DEFAULT_COMPACTION_POLICY,
  retentionOf,
} from "./compaction_policy.ts";
import { OUTBOX_RETRY_BOUND_MS } from "./commit_outbox.ts";

const POLICY = { minCommits: 100, retainCommits: 50, retainMs: 60_000 };

Deno.test("retentionOf: keeps the policy's newest commits and those written within its period", () => {
  assertEquals(retentionOf(POLICY, new Date("2026-10-12T00:10:00.000Z")), {
    commits: 50,
    since: "2026-10-12T00:09:00.000Z",
  });
});

Deno.test("compactionTarget: compacts through the candidate once it folds the minimum", () => {
  assertEquals(
    compactionTarget({ point: 0, through: 400, commits: 100 }, POLICY),
    400,
  );
  assertEquals(
    compactionTarget({ point: 0, through: 400, commits: 99 }, POLICY),
    undefined,
  );
  assertEquals(
    compactionTarget({ point: 7, through: undefined, commits: 0 }, POLICY),
    undefined,
  );
});

Deno.test("DEFAULT_COMPACTION_POLICY: folds 10,000 commits at a time and keeps a week and 10,000 commits", () => {
  assertEquals(DEFAULT_COMPACTION_POLICY, {
    minCommits: 10_000,
    retainCommits: 10_000,
    retainMs: 7 * 24 * 60 * 60 * 1000,
  });
});

Deno.test("compactionBound: a retention cutoff folds no commit newer than it, nor one inside the policy's period", () => {
  const now = new Date("2026-10-12T00:10:00.000Z");
  assertEquals(
    compactionBound(POLICY, now).toISOString(),
    "2026-10-12T00:09:00.000Z",
  );
  // A cutoff older than the period bounds the fold.
  assertEquals(
    compactionBound(POLICY, now, new Date("2026-10-12T00:05:00.000Z"))
      .toISOString(),
    "2026-10-12T00:05:00.000Z",
  );
  // A cutoff inside the period is held back to it.
  assertEquals(
    compactionBound(POLICY, now, new Date("2026-10-12T00:09:30.000Z"))
      .toISOString(),
    "2026-10-12T00:09:00.000Z",
  );
});

Deno.test("retentionOf: a retention cutoff drops the newest-commits floor and keeps everything from the bound on", () => {
  const now = new Date("2026-10-12T00:10:00.000Z");
  assertEquals(
    retentionOf(POLICY, now, new Date("2026-10-12T00:05:00.000Z")),
    { commits: 0, since: "2026-10-12T00:05:00.000Z" },
  );
  assertEquals(
    retentionOf(POLICY, now, new Date("2026-10-12T00:09:59.000Z")),
    { commits: 0, since: "2026-10-12T00:09:00.000Z" },
  );
});

Deno.test("compactionTarget: a retention cutoff folds any commit the retention allows, below the minimum", () => {
  const cutoff = new Date("2026-10-12T00:05:00.000Z");
  assertEquals(
    compactionTarget({ point: 0, through: 3, commits: 1 }, POLICY, cutoff),
    3,
  );
  assertEquals(
    compactionTarget(
      { point: 4, through: undefined, commits: 0 },
      POLICY,
      cutoff,
    ),
    undefined,
  );
});

Deno.test("DEFAULT_COMPACTION_POLICY: its period covers the outbox's retry bound, the safety window a cutoff never folds into", () => {
  assertEquals(
    DEFAULT_COMPACTION_POLICY.retainMs >= OUTBOX_RETRY_BOUND_MS,
    true,
  );
});
