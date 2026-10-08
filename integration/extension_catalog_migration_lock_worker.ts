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

// Worker for extension_catalog_concurrent_migration_test.ts. It stands in
// for a second swamp process: it takes the extension catalog's write lock
// and reports that it holds it. When the test says it is opening the store,
// it commits a write a moment later, then reports that it committed.

import { DatabaseSync } from "node:sqlite";

export type LockWorkerRequest =
  | { kind: "lock"; dbPath: string }
  | { kind: "opening"; holdMs: number };
export type LockWorkerMessage = "locked" | "committed";

declare const self: Worker;

let db: DatabaseSync | undefined;

self.onmessage = (event: MessageEvent<LockWorkerRequest>) => {
  const request = event.data;
  if (request.kind === "lock") {
    db = new DatabaseSync(request.dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    ).run("test:other-process-write");
    self.postMessage("locked" satisfies LockWorkerMessage);
    return;
  }
  setTimeout(() => {
    db?.exec("COMMIT");
    db?.close();
    self.postMessage("committed" satisfies LockWorkerMessage);
  }, request.holdMs);
};
