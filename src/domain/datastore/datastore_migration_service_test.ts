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

import { assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import type { FilesystemDatastoreConfig } from "./datastore_config.ts";
import { migrateDatastore } from "./datastore_migration_service.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-migration-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("migrateDatastore: does not migrate secrets directory", async () => {
  await withTempDir(async (tmpDir) => {
    const sourceDir = join(tmpDir, "source");
    const destDir = join(tmpDir, "dest");

    // Create source with secrets and data dirs
    await Deno.mkdir(join(sourceDir, "secrets", "local_encryption", "v1"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(sourceDir, "secrets", "local_encryption", "v1", "KEY.enc"),
      "encrypted",
    );
    await Deno.mkdir(join(sourceDir, "data"), { recursive: true });
    await Deno.writeTextFile(
      join(sourceDir, "data", "test.json"),
      "{}",
    );
    await Deno.mkdir(destDir, { recursive: true });

    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: destDir,
    };

    const result = await migrateDatastore(sourceDir, destDir, config);

    assertFalse(
      result.directoriesMigrated.includes("secrets"),
      "secrets must not be in directoriesMigrated",
    );
    assertEquals(
      result.directoriesMigrated.includes("data"),
      true,
      "data should be migrated",
    );

    // Source secrets dir must remain intact
    assertEquals(
      await exists(
        join(sourceDir, "secrets", "local_encryption", "v1", "KEY.enc"),
      ),
      true,
      "source secrets must not be touched",
    );

    // Dest must not have secrets
    assertFalse(
      await exists(join(destDir, "secrets")),
      "secrets must not appear in destination",
    );

    // Data should have been migrated
    assertEquals(
      await exists(join(destDir, "data", "test.json")),
      true,
      "data should be copied to destination",
    );
  });
});

Deno.test("migrateDatastore: secrets survives full migration-then-cleanup cycle", async () => {
  await withTempDir(async (tmpDir) => {
    const sourceDir = join(tmpDir, "source");
    const destDir = join(tmpDir, "dest");

    await Deno.mkdir(join(sourceDir, "secrets", "local_encryption"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(sourceDir, "secrets", "local_encryption", ".key"),
      "symmetric-key",
    );
    await Deno.mkdir(join(sourceDir, "data"), { recursive: true });
    await Deno.writeTextFile(join(sourceDir, "data", "d.json"), "{}");
    await Deno.mkdir(destDir, { recursive: true });

    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: destDir,
    };

    const result = await migrateDatastore(sourceDir, destDir, config);

    // Simulate cleanupSourceDirs (setup.ts:463)
    for (const subdir of result.directoriesMigrated) {
      await Deno.remove(join(sourceDir, subdir), { recursive: true });
    }

    // Secrets must survive the cleanup
    assertEquals(
      await exists(join(sourceDir, "secrets", "local_encryption", ".key")),
      true,
      "secrets dir must survive cleanup because it was never migrated",
    );
  });
});
