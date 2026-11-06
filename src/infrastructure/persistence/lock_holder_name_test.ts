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
import { hostname } from "node:os";
import { FileLock } from "./file_lock.ts";
import { lockHolderName, setLockHolderName } from "./lock_holder_name.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

Deno.test("lockHolderName: the OS login until the CLI names the principal serve knows the caller by", async () => {
  try {
    await withMockedEnv({ USER: "pat", USERNAME: undefined }, () => {
      assertEquals(lockHolderName(), "pat");
      setLockHolderName("user:m1");
      assertEquals(lockHolderName(), "user:m1");
      setLockHolderName(undefined);
      assertEquals(lockHolderName(), "pat");
    });
  } finally {
    setLockHolderName(undefined);
  }
});

Deno.test("FileLock: a lock taken after the principal is named shows it as the holder", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-holder-" });
  const lock = new FileLock(dir, { ttlMs: 60_000 });
  try {
    setLockHolderName("user:m1");
    await lock.acquire();
    assertEquals((await lock.inspect())?.holder, `user:m1@${hostname()}`);
  } finally {
    setLockHolderName(undefined);
    await lock.release();
    await Deno.remove(dir, { recursive: true });
  }
});
