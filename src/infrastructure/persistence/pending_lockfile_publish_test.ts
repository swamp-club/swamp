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
  markLockfilePublishPending,
  readLockfilePublishPending,
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

const ENTRY = { version: "1.0.0", pulledAt: "2026-09-30T00:00:00.000Z" };

Deno.test("readLockfilePublishPending: none until a failed publish is recorded", async () => {
  await withRepoDir(async (dir) => {
    assertEquals(await readLockfilePublishPending(dir), { kind: "none" });
    await markLockfilePublishPending(dir, {
      upserts: { "@a/x": ENTRY },
      removals: ["@a/y"],
    });
    assertEquals(await readLockfilePublishPending(dir), {
      kind: "delta",
      delta: { upserts: { "@a/x": ENTRY }, removals: ["@a/y"] },
    });
  });
});

Deno.test("readLockfilePublishPending: a record without a delta reads as unknown", async () => {
  await withRepoDir(async (dir) => {
    await markLockfilePublishPending(dir);
    assertEquals(await readLockfilePublishPending(dir), { kind: "unknown" });
  });
});

Deno.test("readLockfilePublishPending: a malformed record reads as unknown", async () => {
  await withRepoDir(async (dir) => {
    const path = join(dir, ".swamp", "managed-config-lockfile-unpublished");
    for (
      const content of [
        "2026-09-30T00:00:00.000Z",
        "{}",
        JSON.stringify({ version: 1, upserts: [], removals: [] }),
        JSON.stringify({ version: 1, upserts: {}, removals: [1] }),
        JSON.stringify({ version: 1, upserts: { x: {} }, removals: [] }),
      ]
    ) {
      await Deno.writeTextFile(path, content);
      assertEquals(await readLockfilePublishPending(dir), { kind: "unknown" });
    }
  });
});

Deno.test("markLockfilePublishPending: a later record replaces the earlier one", async () => {
  await withRepoDir(async (dir) => {
    await markLockfilePublishPending(dir);
    await markLockfilePublishPending(dir, {
      upserts: {},
      removals: ["@a/x"],
    });
    assertEquals(await readLockfilePublishPending(dir), {
      kind: "delta",
      delta: { upserts: {}, removals: ["@a/x"] },
    });
  });
});

Deno.test("clearLockfilePublishPending: clears the record and tolerates a missing one", async () => {
  await withRepoDir(async (dir) => {
    await clearLockfilePublishPending(dir);
    await markLockfilePublishPending(dir);
    await clearLockfilePublishPending(dir);
    assertEquals(await readLockfilePublishPending(dir), { kind: "none" });
  });
});

Deno.test("markLockfilePublishPending: an incomplete record round-trips its base", async () => {
  await withRepoDir(async (dir) => {
    await markLockfilePublishPending(dir, { upserts: {}, removals: [] }, {
      incomplete: { base: { "@a/x": ENTRY } },
    });
    assertEquals(await readLockfilePublishPending(dir), {
      kind: "delta",
      delta: { upserts: {}, removals: [] },
      incomplete: true,
      base: { "@a/x": ENTRY },
    });
  });
});

Deno.test("readLockfilePublishPending: an incomplete record without a readable base reads as unknown", async () => {
  await withRepoDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, ".swamp", "managed-config-lockfile-unpublished"),
      JSON.stringify({
        version: 1,
        upserts: {},
        removals: [],
        incomplete: true,
      }),
    );
    assertEquals(await readLockfilePublishPending(dir), { kind: "unknown" });
  });
});
