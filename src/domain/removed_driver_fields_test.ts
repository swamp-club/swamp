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
import { z } from "zod";
import {
  addRemovedDriverFieldIssues,
  rejectRemovedDriverFields,
  removedDriverFieldMessage,
} from "./removed_driver_fields.ts";

/** The issues `addRemovedDriverFieldIssues` reports for `data`. */
function issuesOf(data: unknown): { path: string; message: string }[] {
  const result = z.preprocess(addRemovedDriverFieldIssues, z.unknown())
    .safeParse(data);
  return result.success ? [] : result.error.issues.map((issue) => ({
    path: z.core.toDotPath(issue.path),
    message: issue.message,
  }));
}

Deno.test("addRemovedDriverFieldIssues: reports each removed field as an issue (swamp-club#3832)", () => {
  assertEquals(issuesOf({ name: "a", driver: "docker", driverConfig: {} }), [
    { path: "driver", message: removedDriverFieldMessage("driver") },
    {
      path: "driverConfig",
      message: removedDriverFieldMessage("driverConfig"),
    },
  ]);
});

Deno.test("addRemovedDriverFieldIssues: passes data without removed fields through", () => {
  for (const data of [{ name: "a" }, null, "text", 42, [{ driver: "x" }]]) {
    assertEquals(issuesOf(data), []);
  }
});

Deno.test("rejectRemovedDriverFields: still throws the first removed field's message", () => {
  assertThrows(
    () => rejectRemovedDriverFields({ driverConfig: {}, driver: "docker" }),
    Error,
    removedDriverFieldMessage("driver"),
  );
  assertEquals(rejectRemovedDriverFields({ name: "a" }), { name: "a" });
});
