// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { assertErrors, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreSync,
  type DatastoreSyncDeps,
  type DatastoreSyncEvent,
} from "./sync.ts";

function makeDeps(
  overrides: Partial<DatastoreSyncDeps> = {},
): DatastoreSyncDeps {
  return {
    validateSyncSupport: () =>
      Promise.resolve({ supported: true, type: "custom" }),
    pushSync: () => Promise.resolve({ filesPushed: 5 }),
    pullSync: () => Promise.resolve({ filesPulled: 3 }),
    fullSync: () =>
      Promise.resolve({ filesPulled: 3, filesPushed: 5, errors: [] }),
    ...overrides,
  };
}

Deno.test("datastoreSync: push mode success", async () => {
  const deps = makeDeps();

  const events = await collect<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "push" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "syncing", mode: "push" });
  const completed = events[1] as Extract<
    DatastoreSyncEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.mode, "push");
  assertEquals(completed.data.filesPushed, 5);
  assertEquals(completed.data.filesPulled, undefined);
});

Deno.test("datastoreSync: pull mode success", async () => {
  const deps = makeDeps();

  const events = await collect<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "pull" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "syncing", mode: "pull" });
  const completed = events[1] as Extract<
    DatastoreSyncEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.mode, "pull");
  assertEquals(completed.data.filesPulled, 3);
  assertEquals(completed.data.filesPushed, undefined);
});

Deno.test("datastoreSync: full sync success", async () => {
  const deps = makeDeps();

  const events = await collect<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "sync" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "syncing", mode: "sync" });
  const completed = events[1] as Extract<
    DatastoreSyncEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.mode, "sync");
  assertEquals(completed.data.filesPulled, 3);
  assertEquals(completed.data.filesPushed, 5);
  assertEquals(completed.data.errors, []);
});

Deno.test("datastoreSync: unsupported datastore type yields error", async () => {
  const deps = makeDeps({
    validateSyncSupport: () =>
      Promise.resolve({
        supported: false,
        type: "filesystem",
        errorMessage:
          "Datastore sync is only available for sync-capable custom datastores.",
      }),
  });

  const error = await assertErrors<DatastoreSyncEvent>(
    datastoreSync(createLibSwampContext(), deps, { mode: "sync" }),
    "sync_not_supported",
  );
  assertEquals(
    error.message,
    "Datastore sync is only available for sync-capable custom datastores.",
  );
});
