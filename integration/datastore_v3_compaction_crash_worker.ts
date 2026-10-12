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

/**
 * A worker for the compaction crash test (swamp-club#3258): it opens the
 * store, compacts, and inside the batch's transaction, just before it would
 * commit, reports in and spins until the test terminates it. The batch never
 * commits and its connection never closes cleanly.
 */

import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

export interface CompactionCrashRequest {
  readonly dbPath: string;
  readonly through: number;
}
export type CompactionCrashMessage = "folded";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<CompactionCrashRequest>) => {
  const store = SqliteCommitStore.open(event.data.dbPath);
  await store.compactHistory(event.data.through, {
    beforeCommit: () => {
      self.postMessage("folded" satisfies CompactionCrashMessage);
      // Hold the transaction open until terminated.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    },
  });
};
