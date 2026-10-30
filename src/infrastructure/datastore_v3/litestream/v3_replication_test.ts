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

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  DEFAULT_SYNC_DEADLINE_MS,
  MAX_SYNC_DEADLINE_MS,
  setV3ClosingDeadline,
  v3ClosingDeadline,
  v3SyncDeadlineMs,
} from "./v3_replication.ts";

Deno.test("setV3ClosingDeadline: the closing sync takes what is left when it starts, capped, and resets to the CLI default", () => {
  let left = 12_000;
  const deadline = { remaining: (capMs?: number) => capMs ?? left };
  try {
    setV3ClosingDeadline(deadline);
    assertStrictEquals(v3ClosingDeadline(), deadline);
    assertEquals(v3SyncDeadlineMs(), 12_000);
    // Read again when the sync starts, not when the deadline was set.
    left = 3_000;
    assertEquals(v3SyncDeadlineMs(), 3_000);
    // 30 days would overflow setTimeout, which then fires at once.
    left = 30 * 24 * 60 * 60 * 1000;
    assertEquals(v3SyncDeadlineMs(), MAX_SYNC_DEADLINE_MS);
  } finally {
    setV3ClosingDeadline(undefined);
  }
  assertEquals(v3ClosingDeadline(), undefined);
  assertEquals(v3SyncDeadlineMs(), DEFAULT_SYNC_DEADLINE_MS);
});
