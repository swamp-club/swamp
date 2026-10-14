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
  DEFAULT_SYNC_DEADLINE_MS,
  MAX_SYNC_DEADLINE_MS,
  MIN_SERVE_SYNC_DEADLINE_MS,
  setV3SyncDeadline,
  v3SyncDeadlineMs,
} from "./v3_replication.ts";

Deno.test("setV3SyncDeadline: floors a drain's leftover, caps a huge one, and resets to the CLI default", () => {
  try {
    setV3SyncDeadline(-5_000);
    assertEquals(v3SyncDeadlineMs(), MIN_SERVE_SYNC_DEADLINE_MS);
    setV3SyncDeadline(25_000);
    assertEquals(v3SyncDeadlineMs(), 25_000);
    // 30 days would overflow setTimeout, which then fires at once.
    setV3SyncDeadline(30 * 24 * 60 * 60 * 1000);
    assertEquals(v3SyncDeadlineMs(), MAX_SYNC_DEADLINE_MS);
  } finally {
    setV3SyncDeadline(undefined);
  }
  assertEquals(v3SyncDeadlineMs(), DEFAULT_SYNC_DEADLINE_MS);
});
