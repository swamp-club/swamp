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
  compactionTarget,
  DEFAULT_COMPACTION_POLICY,
  retentionOf,
} from "./compaction_policy.ts";

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
