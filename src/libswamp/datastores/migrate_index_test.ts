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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreMigrateIndex,
  type MigrateIndexDeps,
  type MigrateIndexEvent,
} from "./migrate_index.ts";

function makeDeps(
  overrides: Partial<MigrateIndexDeps> = {},
): MigrateIndexDeps {
  return {
    validateMigrationSupport: () =>
      Promise.resolve({ supported: true, type: "custom" }),
    migrateIndex: () =>
      Promise.resolve({
        version: 2,
        partitions: ["models--my-model", "models--other"],
        commitSeq: 1,
      }),
    ...overrides,
  };
}

Deno.test("datastoreMigrateIndex: successful migration", async () => {
  const deps = makeDeps();

  const events = await collect<MigrateIndexEvent>(
    datastoreMigrateIndex(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "migrating" });
  const completed = events[1] as Extract<
    MigrateIndexEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.version, 2);
  assertEquals(completed.data.partitions, [
    "models--my-model",
    "models--other",
  ]);
  assertEquals(completed.data.commitSeq, 1);
});

Deno.test("datastoreMigrateIndex: not supported yields not_supported event", async () => {
  const deps = makeDeps({
    validateMigrationSupport: () =>
      Promise.resolve({
        supported: false,
        type: "filesystem",
        errorMessage:
          "Index migration is only available for sync-capable custom datastores.",
      }),
  });

  const events = await collect<MigrateIndexEvent>(
    datastoreMigrateIndex(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const event = events[0] as Extract<
    MigrateIndexEvent,
    { kind: "not_supported" }
  >;
  assertEquals(event.kind, "not_supported");
  assertEquals(
    event.message,
    "Index migration is only available for sync-capable custom datastores.",
  );
});

Deno.test("datastoreMigrateIndex: not supported uses default message when errorMessage omitted", async () => {
  const deps = makeDeps({
    validateMigrationSupport: () =>
      Promise.resolve({
        supported: false,
        type: "filesystem",
      }),
  });

  const events = await collect<MigrateIndexEvent>(
    datastoreMigrateIndex(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 1);
  const event = events[0] as Extract<
    MigrateIndexEvent,
    { kind: "not_supported" }
  >;
  assertEquals(event.kind, "not_supported");
  assertEquals(
    event.message,
    'Datastore type "filesystem" does not support index migration.',
  );
});

Deno.test("datastoreMigrateIndex: empty partitions on fresh datastore", async () => {
  const deps = makeDeps({
    migrateIndex: () =>
      Promise.resolve({
        version: 2,
        partitions: [],
        commitSeq: 1,
      }),
  });

  const events = await collect<MigrateIndexEvent>(
    datastoreMigrateIndex(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "migrating" });
  const completed = events[1] as Extract<
    MigrateIndexEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.partitions, []);
  assertEquals(completed.data.commitSeq, 1);
});
