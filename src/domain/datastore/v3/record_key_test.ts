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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { MAX_RECORD_KEY_LENGTH, RecordKey } from "./record_key.ts";

Deno.test("RecordKey.create: accepts today's cache-layout paths", () => {
  for (
    const path of [
      "data/@swamp/aws-ec2/6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b/vpc/7/raw",
      "data/swamp/grant/id/grant-main/latest",
      "workflow-runs/wf/workflow-run-run.yaml",
      "config/models/aws/web.yaml",
      "config/upstream_extensions.json",
      ".hidden/file",
    ]
  ) {
    assertEquals(RecordKey.create(path).toString(), path);
  }
});

Deno.test("RecordKey.create: rejects paths that escape or are not relative", () => {
  for (
    const path of [
      "",
      "/data/x",
      "data/",
      "data//x",
      "data/./x",
      "data/../x",
      "..",
      "data\\x",
      "data/x\0",
      "a".repeat(MAX_RECORD_KEY_LENGTH + 1),
    ]
  ) {
    assertThrows(() => RecordKey.create(path), Error, undefined, path);
  }
});

Deno.test("RecordKey.fromJSON: round-trips and rejects non-strings", () => {
  const key = RecordKey.create("data/x/1/raw");
  assert(RecordKey.fromJSON(JSON.parse(JSON.stringify(key))).equals(key));
  assertThrows(() => RecordKey.fromJSON(7), TypeError);
});
