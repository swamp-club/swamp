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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream, type DatastoreSyncEvent } from "../../libswamp/mod.ts";
import { createDatastoreSyncRenderer } from "./datastore_sync.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: DatastoreSyncEvent[],
): AsyncGenerator<DatastoreSyncEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogDatastoreSyncRenderer: pull mode completes without error", async () => {
  const renderer = createDatastoreSyncRenderer("log");
  const events: DatastoreSyncEvent[] = [
    { kind: "syncing", mode: "pull" },
    { kind: "completed", data: { mode: "pull", filesPulled: 42 } },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogDatastoreSyncRenderer: push mode completes without error", async () => {
  const renderer = createDatastoreSyncRenderer("log");
  const events: DatastoreSyncEvent[] = [
    { kind: "syncing", mode: "push" },
    { kind: "completed", data: { mode: "push", filesPushed: 10 } },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogDatastoreSyncRenderer: sync mode completes without error", async () => {
  const renderer = createDatastoreSyncRenderer("log");
  const events: DatastoreSyncEvent[] = [
    { kind: "syncing", mode: "sync" },
    {
      kind: "completed",
      data: { mode: "sync", filesPulled: 3, filesPushed: 5, errors: [] },
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogDatastoreSyncRenderer: syncing outputs initial message per mode", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    for (const mode of ["pull", "push", "sync"] as const) {
      logs.length = 0;
      const renderer = createDatastoreSyncRenderer("log");
      const handlers = renderer.handlers();
      handlers.syncing({ kind: "syncing", mode });

      const expected: Record<string, string> = {
        pull: "Pulling all data from remote...",
        push: "Pushing all local data to remote...",
        sync: "Syncing with remote...",
      };
      assertEquals(logs[0], expected[mode]);

      // Clean up timer to avoid leaking
      handlers.completed({
        kind: "completed",
        data: { mode, filesPulled: 0, filesPushed: 0, errors: [] },
      });
    }
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogDatastoreSyncRenderer: completed clears activity timer without leaking", async () => {
  const renderer = createDatastoreSyncRenderer("log");
  const handlers = renderer.handlers();

  handlers.syncing({ kind: "syncing", mode: "pull" });
  handlers.completed({
    kind: "completed",
    data: { mode: "pull", filesPulled: 10 },
  });

  // Wait longer than the activity interval to verify no leaked timer fires
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogDatastoreSyncRenderer: error clears activity timer without leaking", async () => {
  const renderer = createDatastoreSyncRenderer("log");
  const handlers = renderer.handlers();

  handlers.syncing({ kind: "syncing", mode: "sync" });

  try {
    handlers.error({
      kind: "error",
      error: { code: "sync_failed", message: "Connection lost" },
    });
  } catch {
    // Expected UserError
  }

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogDatastoreSyncRenderer: error event throws UserError", () => {
  const renderer = createDatastoreSyncRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "sync_failed", message: "Sync failed" },
      }),
    UserError,
    "Sync failed",
  );
});

Deno.test("JsonDatastoreSyncRenderer: completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createDatastoreSyncRenderer("json");
    const events: DatastoreSyncEvent[] = [
      { kind: "syncing", mode: "pull" },
      { kind: "completed", data: { mode: "pull", filesPulled: 42 } },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.mode, "pull");
    assertEquals(parsed.filesPulled, 42);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonDatastoreSyncRenderer: syncing event produces no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createDatastoreSyncRenderer("json");
    const handlers = renderer.handlers();
    handlers.syncing({ kind: "syncing", mode: "pull" });
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonDatastoreSyncRenderer: error event throws UserError", () => {
  const renderer = createDatastoreSyncRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "sync_failed", message: "Sync failed" },
      }),
    UserError,
    "Sync failed",
  );
});
