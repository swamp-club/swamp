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

// another process's connection holding a new database's write lock, as a
// migration does; a thread of its own because the test's open blocks in
// SQLite's busy wait. It imports node:sqlite alone, never npm

import { DatabaseSync } from "node:sqlite";
import { LOADED } from "./graph_worker.ts";

export type WriteLockHolderRequest =
  | { readonly kind: "hold"; readonly dbPath: string; readonly holdMs: number }
  | "release";

export type WriteLockHolderMessage =
  | { readonly locked: true }
  | { readonly committing: true }
  | { readonly released: true }
  | { readonly failed: string };

declare const self: Worker;

let release: (() => void) | undefined;

self.onmessage = (event: MessageEvent<WriteLockHolderRequest>) => {
  if (event.data === "release") {
    release?.();
    return;
  }
  hold(event.data).catch((error) =>
    self.postMessage({ failed: String(error) } satisfies WriteLockHolderMessage)
  );
};

async function hold(
  request: Exclude<WriteLockHolderRequest, "release">,
): Promise<void> {
  const db = new DatabaseSync(request.dbPath);
  try {
    // as every swamp connection: a commit waits out another connection's read
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE holder (x)");
    const released = new Promise<void>((done) => release = done);
    self.postMessage({ locked: true } satisfies WriteLockHolderMessage);
    await released;
    // held a while past the request, so the other connection meets the lock
    await new Promise((done) => setTimeout(done, request.holdMs));
    self.postMessage({ committing: true } satisfies WriteLockHolderMessage);
    db.exec("COMMIT");
  } catch (error) {
    // a failed hold lets go of its lock, so the test reports this error
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  self.postMessage({ released: true } satisfies WriteLockHolderMessage);
}

self.postMessage(LOADED);
