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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { SharedDatastoreWriteTracker } from "./shared_datastore_write_tracker.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-write-tracker-test-" });
  try {
    fn(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

Deno.test("SharedDatastoreWriteTracker: no directory means no foreign writers", () => {
  withDir((dir) => {
    const tracker = new SharedDatastoreWriteTracker(join(dir, "writers"));
    assertEquals(tracker.foreignTokens("me"), "{}");
  });
});

Deno.test("SharedDatastoreWriteTracker: recordWrite creates the directory and ignores the caller's own token", () => {
  withDir((dir) => {
    const tracker = new SharedDatastoreWriteTracker(join(dir, "writers"));
    tracker.recordWrite("me");
    assertEquals(tracker.foreignTokens("me"), "{}");
    assertNotEquals(tracker.foreignTokens("someone-else"), "{}");
  });
});

Deno.test("SharedDatastoreWriteTracker: every write by another writer changes the foreign tokens", () => {
  withDir((dir) => {
    const tracker = new SharedDatastoreWriteTracker(join(dir, "writers"));
    const before = tracker.foreignTokens("me");
    tracker.recordWrite("other");
    const afterFirst = tracker.foreignTokens("me");
    tracker.recordWrite("other");
    const afterSecond = tracker.foreignTokens("me");
    assertNotEquals(afterFirst, before);
    assertNotEquals(afterSecond, afterFirst);
  });
});

Deno.test("SharedDatastoreWriteTracker: tokens serialise in a stable order and skip temp files", () => {
  withDir((dir) => {
    const writers = join(dir, "writers");
    Deno.mkdirSync(writers);
    Deno.writeTextFileSync(join(writers, "b"), "2");
    Deno.writeTextFileSync(join(writers, "a"), "1");
    Deno.writeTextFileSync(join(writers, "a.123.tmp"), "partial");
    const tracker = new SharedDatastoreWriteTracker(writers);
    assertEquals(tracker.foreignTokens("me"), '{"a":"1","b":"2"}');
  });
});

Deno.test("SharedDatastoreWriteTracker: a removed writer changes the foreign tokens", () => {
  withDir((dir) => {
    const writers = join(dir, "writers");
    const tracker = new SharedDatastoreWriteTracker(writers);
    tracker.recordWrite("other");
    const before = tracker.foreignTokens("me");
    Deno.removeSync(join(writers, "other"));
    assertNotEquals(tracker.foreignTokens("me"), before);
  });
});
