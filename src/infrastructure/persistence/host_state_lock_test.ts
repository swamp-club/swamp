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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  acquireHostStateLock,
  HOST_STATE_LOCK_FILE,
} from "./host_state_lock.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("acquireHostStateLock: a second lock on one state folder is refused, naming the folder", async () => {
  await withTempDir(async (dir) => {
    const stateDir = join(dir, "host");
    const first = await acquireHostStateLock(stateDir);
    try {
      const error = await assertRejects(
        () => acquireHostStateLock(stateDir),
        UserError,
      );
      assertStringIncludes(error.message, stateDir);
      assertEquals(error.code, "host_state_locked");
    } finally {
      first.release();
    }
  });
});

Deno.test("acquireHostStateLock: once released, the state folder can be locked again", async () => {
  await withTempDir(async (dir) => {
    const first = await acquireHostStateLock(dir);
    first.release();
    first.release();
    const second = await acquireHostStateLock(dir);
    second.release();
  });
});

Deno.test("acquireHostStateLock: a lock file left on disk by a host that died does not block the next start", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, HOST_STATE_LOCK_FILE), "left behind");
    const lock = await acquireHostStateLock(dir);
    lock.release();
  });
});

Deno.test("acquireHostStateLock: creates the state folder when it is missing", async () => {
  await withTempDir(async (dir) => {
    const stateDir = join(dir, "data", "host");
    const lock = await acquireHostStateLock(stateDir);
    try {
      assertEquals((await Deno.stat(stateDir)).isDirectory, true);
    } finally {
      lock.release();
    }
  });
});

Deno.test("HOST_STATE_LOCK_FILE: no workspace's per-name lock can be the host's lock file", () => {
  // the root's services lock a workspace at .<name>.lock in the same folder
  assertEquals(HOST_STATE_LOCK_FILE.endsWith(".lock"), false);
});
