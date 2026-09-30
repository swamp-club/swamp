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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { exists } from "@std/fs";
import {
  ABANDONED_TEMP_FILE_MAX_AGE_MS,
  removeAbandonedTempFiles,
} from "./abandoned_temp_files.ts";

const PREFIX = ".deno.tmp.";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-abandoned-tmp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function setAge(path: string, ageMs: number): Promise<void> {
  const time = new Date(Date.now() - ageMs);
  await Deno.utime(path, time, time);
}

Deno.test("removeAbandonedTempFiles: keeps a fresh temp file that a live process may own", async () => {
  await withTempDir(async (dir) => {
    const fresh = join(dir, `${PREFIX}${crypto.randomUUID()}`);
    await Deno.writeTextFile(fresh, "in-flight");

    await removeAbandonedTempFiles(dir, PREFIX);

    assertEquals(await exists(fresh), true);
  });
});

Deno.test("removeAbandonedTempFiles: removes a temp file older than the threshold", async () => {
  await withTempDir(async (dir) => {
    const stale = join(dir, `${PREFIX}${crypto.randomUUID()}`);
    await Deno.writeTextFile(stale, "crashed");
    await setAge(stale, ABANDONED_TEMP_FILE_MAX_AGE_MS + 60_000);

    await removeAbandonedTempFiles(dir, PREFIX);

    assertEquals(await exists(stale), false);
  });
});

Deno.test("removeAbandonedTempFiles: ignores old files without the prefix", async () => {
  await withTempDir(async (dir) => {
    const other = join(dir, "deno");
    await Deno.writeTextFile(other, "binary");
    await setAge(other, ABANDONED_TEMP_FILE_MAX_AGE_MS + 60_000);

    await removeAbandonedTempFiles(dir, PREFIX);

    assertEquals(await exists(other), true);
  });
});

Deno.test("removeAbandonedTempFiles: keeps a temp file with a future mtime", async () => {
  await withTempDir(async (dir) => {
    const future = join(dir, `${PREFIX}${crypto.randomUUID()}`);
    await Deno.writeTextFile(future, "clock skew");
    await setAge(future, -ABANDONED_TEMP_FILE_MAX_AGE_MS);

    await removeAbandonedTempFiles(dir, PREFIX);

    assertEquals(await exists(future), true);
  });
});

Deno.test("removeAbandonedTempFiles: leaves an old prefixed directory alone", async () => {
  await withTempDir(async (dir) => {
    const subdir = join(dir, `${PREFIX}${crypto.randomUUID()}`);
    await Deno.mkdir(subdir);
    await setAge(subdir, ABANDONED_TEMP_FILE_MAX_AGE_MS + 60_000);

    await removeAbandonedTempFiles(dir, PREFIX);

    assertEquals(await exists(subdir), true);
  });
});

Deno.test("removeAbandonedTempFiles: tolerates a missing directory", async () => {
  await withTempDir(async (dir) => {
    await removeAbandonedTempFiles(join(dir, "missing"), PREFIX);
  });
});
