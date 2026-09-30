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
import { join } from "@std/path";
import {
  clearLockfilePublishPending,
  isLockfilePublishPending,
  markLockfilePublishPending,
} from "./pending_lockfile_publish.ts";

async function withRepoDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-pending-publish-" });
  try {
    await Deno.mkdir(join(dir, ".swamp"));
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("isLockfilePublishPending: false until a failed publish is recorded", async () => {
  await withRepoDir(async (dir) => {
    assertEquals(await isLockfilePublishPending(dir), false);
    await markLockfilePublishPending(dir);
    assertEquals(await isLockfilePublishPending(dir), true);
  });
});

Deno.test("clearLockfilePublishPending: clears the record and tolerates a missing one", async () => {
  await withRepoDir(async (dir) => {
    await clearLockfilePublishPending(dir);
    await markLockfilePublishPending(dir);
    await markLockfilePublishPending(dir);
    await clearLockfilePublishPending(dir);
    assertEquals(await isLockfilePublishPending(dir), false);
  });
});
