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

import type { DatabaseSync } from "node:sqlite";

const WAL_SWITCH_WAIT_MS = 5_000;

/**
 * SQLite answers a journal-mode switch that meets another connection's write
 * lock with SQLITE_BUSY at once, skipping busy_timeout; two processes opening a
 * new database both switch, so the switch is retried for as long as the timeout
 */
export function useWalJournal(db: DatabaseSync): void {
  const deadline = Date.now() + WAL_SWITCH_WAIT_MS;
  let retryMs = 10;
  for (;;) {
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as
        | { journal_mode: string }
        | undefined;
      // WAL persists in the file: one already in WAL is not switched again
      if (mode?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/database is locked/i.test(error.message) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    retryMs = Math.min(retryMs * 2, 200);
  }
}
