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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  UNREADABLE_RECORD_CODE,
  type UnreadableRecord,
  UnreadableRecordError,
} from "./read_model.ts";

function unreadable(overrides: Partial<UnreadableRecord>): UnreadableRecord {
  return {
    namespace: "",
    recordKey: "data/m/a/1/raw",
    partition: "p",
    seq: 1,
    position: 1,
    reason: "missing",
    lastAttempt: new Date(0),
    ...overrides,
  };
}

Deno.test("UnreadableRecordError: names the chunk and why it fails, or a chunk of the content when none is known (swamp-club#3617)", () => {
  const chunk = "a".repeat(64);
  const named = new UnreadableRecordError(
    unreadable({ chunk, reason: "damaged" }),
  );
  assertStringIncludes(
    named.message,
    `The record data/m/a/1/raw cannot be read: chunk ${chunk} is damaged in the datastore. `,
  );
  assertEquals(named.code, UNREADABLE_RECORD_CODE);
  assertStringIncludes(
    new UnreadableRecordError(unreadable({})).message,
    "The record data/m/a/1/raw cannot be read: a chunk of its content is missing in the datastore. ",
  );
});
