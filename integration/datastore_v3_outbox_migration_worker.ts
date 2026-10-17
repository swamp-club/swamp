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
 * One opener for the outbox migration test (swamp-club#3564): a worker
 * whose own connection opens the outbox once the test lets every opener
 * go at once.
 */

import { SqliteCommitOutbox } from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";

export interface OutboxOpenRequest {
  readonly path: string;
  /** One Int32 the test sets to 1 to start every opener together. */
  readonly start: SharedArrayBuffer;
}

export type OutboxOpenResult =
  | { readonly kind: "ready" }
  | { readonly kind: "opened"; readonly entries: number }
  | { readonly kind: "failed"; readonly message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<OutboxOpenRequest>) => void) | null;
  postMessage(message: OutboxOpenResult): void;
};

scope.onmessage = async (event) => {
  const { path, start } = event.data;
  const flag = new Int32Array(start);
  scope.postMessage({ kind: "ready" });
  Atomics.wait(flag, 0, 0);
  const outbox = new SqliteCommitOutbox(path);
  let result: OutboxOpenResult;
  try {
    const { entries } = await outbox.entries();
    result = { kind: "opened", entries: entries.length };
  } catch (error) {
    result = {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await outbox.close();
  }
  // Reported once the connection is closed, so the test reads the file after
  // every opener let go of it.
  scope.postMessage(result);
};
