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
import type { DatastoreSyncOptions } from "../domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  createGrantWriteCommit,
  publishGrantWrites,
} from "./grant_write_tracking.ts";
import { createSyncGate, type SyncGate } from "./sync_gate.ts";

await initializeLogging({});

type SyncEvent =
  | { kind: "mark"; path: string }
  | { kind: "push"; namespace?: string; gateHeld?: boolean };

function recordingDeps(gate?: SyncGate, failPush = false) {
  const events: SyncEvent[] = [];
  return {
    events,
    deps: {
      syncService: {
        pushChanged(options?: DatastoreSyncOptions) {
          events.push({
            kind: "push",
            namespace: options?.namespace,
            gateHeld: gate?.exclusiveHeld,
          });
          return failPush
            ? Promise.reject(new Error("datastore unreachable"))
            : Promise.resolve(0);
        },
      },
      markDirty(path?: string) {
        events.push({ kind: "mark", path: path ?? "<bare>" });
        return Promise.resolve();
      },
      namespace: "infra",
    },
  };
}

Deno.test("publishGrantWrites: marks each path, then pushes once to the namespace", async () => {
  const { events, deps } = recordingDeps();

  await publishGrantWrites(["a", "b"], deps);

  assertEquals(events, [
    { kind: "mark", path: "a" },
    { kind: "mark", path: "b" },
    { kind: "push", namespace: "infra", gateHeld: undefined },
  ]);
});

Deno.test("publishGrantWrites: does not push when nothing was written", async () => {
  const { events, deps } = recordingDeps();

  await publishGrantWrites([], deps);

  assertEquals(events, []);
});

Deno.test("publishGrantWrites: is a no-op without a sync service", async () => {
  await publishGrantWrites(["a"], {});
});

Deno.test("publishGrantWrites: logs a failed push instead of throwing", async () => {
  const { events, deps } = recordingDeps(undefined, true);

  await publishGrantWrites(["a"], deps);

  assertEquals(events.at(-1)?.kind, "push");
});

Deno.test("createGrantWriteCommit: pushes the unit's writes inside the exclusive gate", async () => {
  const gate = createSyncGate();
  const { events, deps } = recordingDeps(gate);
  let pending = ["left-by-a-failed-unit"];
  const tracking = {
    takeWrittenPaths() {
      const paths = pending;
      pending = [];
      return paths;
    },
  };
  const commit = createGrantWriteCommit(gate, tracking, deps);

  const result = await commit(() => {
    assertEquals(gate.exclusiveHeld, true);
    pending.push("grant-data-dir");
    return Promise.resolve("done");
  });

  assertEquals(result, "done");
  assertEquals(events, [
    { kind: "mark", path: "left-by-a-failed-unit" },
    { kind: "mark", path: "grant-data-dir" },
    { kind: "push", namespace: "infra", gateHeld: true },
  ]);
  assertEquals(gate.exclusiveHeld, false);
});
