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
import { LockTimeoutError } from "./distributed_lock.ts";

Deno.test("LockTimeoutError - includes holder info when available", () => {
  const error = new LockTimeoutError(
    ".datastore.lock",
    {
      holder: "paul@pauls-macbook",
      hostname: "pauls-macbook",
      pid: 12345,
      acquiredAt: "2026-03-10T12:00:00.000Z",
      ttlMs: 30000,
    },
    60000,
  );

  assertEquals(error.name, "LockTimeoutError");
  assertStringIncludes(error.message, "paul@pauls-macbook");
  assertStringIncludes(error.message, "12345");
  assertStringIncludes(error.message, "60000");
  assertEquals(error.lockKey, ".datastore.lock");
  assertEquals(error.waitedMs, 60000);
  assertEquals(error.holder?.pid, 12345);
});

Deno.test("LockTimeoutError - works without holder info", () => {
  const error = new LockTimeoutError(
    ".datastore.lock",
    null,
    5000,
  );

  assertEquals(error.name, "LockTimeoutError");
  assertStringIncludes(error.message, ".datastore.lock");
  assertStringIncludes(error.message, "5000");
  assertEquals(error.holder, null);
});

Deno.test("LockTimeoutError - is an instance of Error", () => {
  const error = new LockTimeoutError("key", null, 1000);
  assertEquals(error instanceof Error, true);
  assertEquals(error instanceof LockTimeoutError, true);
});
