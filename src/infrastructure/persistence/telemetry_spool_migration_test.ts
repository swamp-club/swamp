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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { migrateRepoTelemetryToGlobal } from "./telemetry_spool_migration.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-tel-mig-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("migrateRepoTelemetryToGlobal: returns 0 when no repo-local spool exists", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const destDir = join(dir, "global");
    const count = await migrateRepoTelemetryToGlobal(repoDir, destDir);
    assertEquals(count, 0);
  });
});

Deno.test("migrateRepoTelemetryToGlobal: moves unflushed entries and leaves flushed ones", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const destDir = join(dir, "global");
    const spool = swampPath(repoDir, SWAMP_SUBDIRS.telemetry);
    await ensureDir(spool);

    const unflushedA = "telemetry-2026-07-13-aaaaaaaa.json";
    const unflushedB = "telemetry-2026-07-13-bbbbbbbb.json";
    const flushed = "telemetry-2026-07-13-cccccccc.flushed.json";
    await Deno.writeTextFile(join(spool, unflushedA), '{"id":"a"}');
    await Deno.writeTextFile(join(spool, unflushedB), '{"id":"b"}');
    await Deno.writeTextFile(join(spool, flushed), '{"id":"c"}');

    const count = await migrateRepoTelemetryToGlobal(repoDir, destDir);
    assertEquals(count, 2);

    // Unflushed entries moved to the destination...
    assert(await fileExists(join(destDir, unflushedA)));
    assert(await fileExists(join(destDir, unflushedB)));
    assertEquals(
      await Deno.readTextFile(join(destDir, unflushedA)),
      '{"id":"a"}',
    );
    // ...and removed from the source.
    assertEquals(await fileExists(join(spool, unflushedA)), false);
    assertEquals(await fileExists(join(spool, unflushedB)), false);

    // The already-flushed entry is left behind and not copied.
    assert(await fileExists(join(spool, flushed)));
    assertEquals(await fileExists(join(destDir, flushed)), false);

    // The (now-empty) repo-local spool directory is left orphaned, not deleted.
    assert(await fileExists(spool));
  });
});

Deno.test("migrateRepoTelemetryToGlobal: ignores non-telemetry files", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const destDir = join(dir, "global");
    const spool = swampPath(repoDir, SWAMP_SUBDIRS.telemetry);
    await ensureDir(spool);
    await Deno.writeTextFile(join(spool, "README.txt"), "not telemetry");
    await Deno.writeTextFile(join(spool, "telemetry-2026-07-13-dd.json"), "{}");

    const count = await migrateRepoTelemetryToGlobal(repoDir, destDir);
    assertEquals(count, 1);
    assert(await fileExists(join(spool, "README.txt")));
  });
});
