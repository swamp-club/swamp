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

// The store's behaviour on a real commits.db is tested in
// integration/sqlite_commit_store_test.ts; these cover what it refuses before
// it touches the filesystem.

import { assertThrows } from "@std/assert";
import { join } from "@std/path";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";

/** A path that is never created: open refuses before opening it. */
const NEVER_OPENED = join("never", "created", "commits.db");

Deno.test("SqliteCommitStore.open: refuses a cache size that is not a positive integer", () => {
  for (const cachedPartitions of [0, -1, 1.5, Number.NaN]) {
    assertThrows(
      () => SqliteCommitStore.open(NEVER_OPENED, { cachedPartitions }),
      Error,
      "cachedPartitions must be a positive integer",
    );
  }
});

Deno.test("SqliteCommitStore.open: refuses a snapshot interval that is not a positive integer", () => {
  for (const snapshotInterval of [0, -3, 2.5, Infinity]) {
    assertThrows(
      () => SqliteCommitStore.open(NEVER_OPENED, { snapshotInterval }),
      Error,
      "snapshotInterval must be a positive integer",
    );
  }
});
