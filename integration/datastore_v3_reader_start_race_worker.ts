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

// stands in for another process on the same checkout: a read-only command
// aligning its view, or a connection holding a new database's write lock

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  alignCheckoutView,
  type CheckoutView,
} from "../src/infrastructure/datastore_v3/checkout_view.ts";
import type { V3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";

export type StartRaceRequest =
  | {
    readonly kind: "align";
    readonly repoDir: string;
    readonly datastorePath: string;
    readonly view: CheckoutView;
  }
  | { readonly kind: "hold"; readonly dbPath: string; readonly holdMs: number };

export type StartRaceMessage =
  | { readonly waiting: true }
  | { readonly aligned: number }
  | { readonly locked: true }
  | { readonly released: true }
  | { readonly failed: string };

declare const self: Worker;

let release: (() => void) | undefined;

self.onmessage = (event: MessageEvent<StartRaceRequest | "release">) => {
  if (event.data === "release") {
    release?.();
    return;
  }
  const request = event.data;
  const run = request.kind === "align" ? align(request) : hold(request);
  run.catch((error) =>
    self.postMessage({ failed: String(error) } satisfies StartRaceMessage)
  );
};

/** patched in this worker's realm only: the second listing means it waits */
function reportLeaseWait(datastorePath: string): void {
  const leaseDir = join(datastorePath, "_control", "writer");
  const readDir = Deno.readDir.bind(Deno);
  let reads = 0;
  Object.defineProperty(Deno, "readDir", {
    configurable: true,
    value: (path: string | URL) => {
      if (String(path) === leaseDir && ++reads === 2) {
        self.postMessage({ waiting: true } satisfies StartRaceMessage);
      }
      return readDir(path);
    },
  });
}

async function align(
  request: Extract<StartRaceRequest, { kind: "align" }>,
): Promise<void> {
  reportLeaseWait(request.datastorePath);
  let rebuilds = 0;
  const handle = {
    datastorePath: request.datastorePath,
    recoverInterruptedWriter() {
      rebuilds++;
      return Promise.resolve([]);
    },
  } as unknown as V3Datastore;
  await alignCheckoutView(request.repoDir, handle, request.view, {
    holdsWriterLock: false,
  });
  self.postMessage({ aligned: rebuilds } satisfies StartRaceMessage);
}

/** the write lock of a database still in rollback mode, as a migration holds */
async function hold(
  request: Extract<StartRaceRequest, { kind: "hold" }>,
): Promise<void> {
  const db = new DatabaseSync(request.dbPath);
  db.exec("BEGIN IMMEDIATE");
  db.exec("CREATE TABLE holder (x)");
  const released = new Promise<void>((done) => release = done);
  self.postMessage({ locked: true } satisfies StartRaceMessage);
  await released;
  // held a while past the request, so the other connection meets the lock
  await new Promise((done) => setTimeout(done, request.holdMs));
  db.exec("COMMIT");
  db.close();
  self.postMessage({ released: true } satisfies StartRaceMessage);
}
