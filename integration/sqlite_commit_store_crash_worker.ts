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

// Worker for sqlite_commit_store_crash_test.ts. It stands in for a writer
// killed mid-append: it opens commits.db, starts the append's transaction,
// writes the commit row and the head row exactly as the store does, reports
// that it holds them, and waits to be terminated before it can commit.

import { DatabaseSync } from "node:sqlite";

export interface CrashWorkerRequest {
  readonly dbPath: string;
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
  readonly fence: number;
  readonly at: string;
  readonly body: string;
}
export type CrashWorkerMessage = "written";

declare const self: Worker;

self.onmessage = (event: MessageEvent<CrashWorkerRequest>) => {
  const request = event.data;
  const db = new DatabaseSync(request.dbPath);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    "INSERT INTO commits (namespace, partition, seq, txn_id, fence, at, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    request.namespace,
    request.partition,
    request.seq,
    request.txnId,
    request.fence,
    request.at,
    request.body,
  );
  db.prepare(
    "INSERT INTO partition_heads (namespace, partition, seq, highest_fence) VALUES (?, ?, ?, ?)",
  ).run(request.namespace, request.partition, request.seq, request.fence);
  self.postMessage("written" satisfies CrashWorkerMessage);
};
