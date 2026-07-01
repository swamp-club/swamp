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

import { assertStringIncludes, assertThrows } from "@std/assert";
import { createDatastoreMigrateIndexRenderer } from "./datastore_migrate_index.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("createDatastoreMigrateIndexRenderer: log mode handles completed", () => {
  const renderer = createDatastoreMigrateIndexRenderer("log");
  const handlers = renderer.handlers();
  // migrating should not throw
  handlers.migrating({ kind: "migrating" });
  // completed should not throw
  handlers.completed({
    kind: "completed",
    data: { version: 2, partitions: ["a", "b"], commitSeq: 1 },
  });
});

Deno.test("createDatastoreMigrateIndexRenderer: log mode throws UserError on not_supported", () => {
  const renderer = createDatastoreMigrateIndexRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.not_supported({
        kind: "not_supported",
        message: "Not supported",
      }),
    UserError,
    "Not supported",
  );
});

Deno.test("createDatastoreMigrateIndexRenderer: log mode throws UserError on error", () => {
  const renderer = createDatastoreMigrateIndexRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "migrate_failed", message: "Something broke" },
      }),
    UserError,
    "Something broke",
  );
});

Deno.test("createDatastoreMigrateIndexRenderer: json mode outputs structured data on completed", () => {
  const renderer = createDatastoreMigrateIndexRenderer("json");
  const handlers = renderer.handlers();
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    handlers.migrating({ kind: "migrating" });
    handlers.completed({
      kind: "completed",
      data: { version: 2, partitions: ["shard-a"], commitSeq: 1 },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertStringIncludes(JSON.stringify(parsed), '"version":2');
  assertStringIncludes(JSON.stringify(parsed), '"shard-a"');
});

Deno.test("createDatastoreMigrateIndexRenderer: json mode throws UserError on not_supported", () => {
  const renderer = createDatastoreMigrateIndexRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.not_supported({
        kind: "not_supported",
        message: "Update extension",
      }),
    UserError,
    "Update extension",
  );
});
