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
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  getMigrationSentinelPath,
  migrateConfigToDatastore,
} from "./managed_config_migration.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-migration-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function setupRepoWithAllSources(
  repoDir: string,
): Promise<{ lockfilePath: string; pulledExtensionsSource: string }> {
  await ensureDir(join(repoDir, "models"));
  await Deno.writeTextFile(
    join(repoDir, "models", "my-model.yaml"),
    "type: my-model\n",
  );

  await ensureDir(join(repoDir, "workflows"));
  await Deno.writeTextFile(
    join(repoDir, "workflows", "daily.yaml"),
    "name: daily\n",
  );

  await ensureDir(join(repoDir, "vaults"));
  await Deno.writeTextFile(
    join(repoDir, "vaults", "aws.yaml"),
    "type: aws-secrets\n",
  );

  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({ "@scope/ext": { version: "1.0.0" } }),
  );

  const pulledExtensionsSource = join(repoDir, ".swamp", "pulled-extensions");
  await ensureDir(join(pulledExtensionsSource, "@scope", "ext", "models"));
  await Deno.writeTextFile(
    join(pulledExtensionsSource, "@scope", "ext", "models", "foo.ts"),
    "export default {};\n",
  );

  return { lockfilePath, pulledExtensionsSource };
}

Deno.test("migrateConfigToDatastore: copies all sources into configRoot", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");
    const { lockfilePath, pulledExtensionsSource } =
      await setupRepoWithAllSources(repoDir);

    const result = await migrateConfigToDatastore(
      repoDir,
      lockfilePath,
      configRoot,
      pulledExtensionsSource,
    );

    assertEquals(result.copiedModels, true);
    assertEquals(result.copiedWorkflows, true);
    assertEquals(result.copiedVaults, true);
    assertEquals(result.copiedLockfile, true);
    assertEquals(result.copiedPulledExtensions, true);
    assertEquals(result.alreadyMigrated, false);

    const modelContent = await Deno.readTextFile(
      join(configRoot, "models", "my-model.yaml"),
    );
    assertEquals(modelContent, "type: my-model\n");

    const workflowContent = await Deno.readTextFile(
      join(configRoot, "workflows", "daily.yaml"),
    );
    assertEquals(workflowContent, "name: daily\n");

    const vaultContent = await Deno.readTextFile(
      join(configRoot, "vaults", "aws.yaml"),
    );
    assertEquals(vaultContent, "type: aws-secrets\n");

    const lockfileContent = await Deno.readTextFile(
      join(configRoot, "upstream_extensions.json"),
    );
    assertStringIncludes(lockfileContent, "@scope/ext");

    const extensionSource = await Deno.readTextFile(
      join(
        configRoot,
        "pulled-extensions",
        "@scope",
        "ext",
        "models",
        "foo.ts",
      ),
    );
    assertEquals(extensionSource, "export default {};\n");
  });
});

Deno.test("migrateConfigToDatastore: sentinel prevents re-migration", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");
    await ensureDir(configRoot);

    await Deno.writeTextFile(
      join(configRoot, "managed-config-migrated.json"),
      JSON.stringify({ migratedAt: "2026-01-01T00:00:00.000Z" }),
    );

    await ensureDir(join(repoDir, "models"));
    await Deno.writeTextFile(
      join(repoDir, "models", "should-not-copy.yaml"),
      "nope\n",
    );

    const result = await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "lockfile.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );

    assertEquals(result.alreadyMigrated, true);
    assertEquals(result.copiedModels, false);
    assertEquals(result.copiedWorkflows, false);
    assertEquals(result.copiedVaults, false);
    assertEquals(result.copiedLockfile, false);
    assertEquals(result.copiedPulledExtensions, false);

    // models dir should NOT have been created in configRoot
    try {
      await Deno.stat(join(configRoot, "models", "should-not-copy.yaml"));
      throw new Error("Expected NotFound");
    } catch (e) {
      assertEquals(e instanceof Deno.errors.NotFound, true);
    }
  });
});

Deno.test("migrateConfigToDatastore: skips missing source directories gracefully", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");

    // No models/, workflows/, vaults/, lockfile, or pulled-extensions exist
    const result = await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "nonexistent", "upstream_extensions.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );

    assertEquals(result.copiedModels, false);
    assertEquals(result.copiedWorkflows, false);
    assertEquals(result.copiedVaults, false);
    assertEquals(result.copiedLockfile, false);
    assertEquals(result.copiedPulledExtensions, false);
    assertEquals(result.alreadyMigrated, false);
  });
});

Deno.test("migrateConfigToDatastore: copies only existing sources", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");

    // Only models/ exists
    await ensureDir(join(repoDir, "models"));
    await Deno.writeTextFile(
      join(repoDir, "models", "partial.yaml"),
      "partial\n",
    );

    const result = await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "nonexistent", "upstream_extensions.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );

    assertEquals(result.copiedModels, true);
    assertEquals(result.copiedWorkflows, false);
    assertEquals(result.copiedVaults, false);
    assertEquals(result.copiedLockfile, false);
    assertEquals(result.copiedPulledExtensions, false);

    const content = await Deno.readTextFile(
      join(configRoot, "models", "partial.yaml"),
    );
    assertEquals(content, "partial\n");
  });
});

Deno.test("migrateConfigToDatastore: writes sentinel file after migration", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");

    await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "nonexistent.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );

    const stat = await Deno.stat(
      join(configRoot, "managed-config-migrated.json"),
    );
    assertEquals(stat.isFile, true);
  });
});

Deno.test("migrateConfigToDatastore: sentinel contains migratedAt and sources", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");
    const lockfilePath = join(
      repoDir,
      "extensions",
      "upstream_extensions.json",
    );
    const pulledSource = join(repoDir, ".swamp", "pulled-extensions");

    await migrateConfigToDatastore(
      repoDir,
      lockfilePath,
      configRoot,
      pulledSource,
    );

    const sentinel = JSON.parse(
      await Deno.readTextFile(
        join(configRoot, "managed-config-migrated.json"),
      ),
    );

    assertEquals(typeof sentinel.migratedAt, "string");
    assertEquals(Array.isArray(sentinel.sources), true);
    assertEquals(sentinel.sources.length, 5);
    assertStringIncludes(sentinel.sources[0], "models");
    assertStringIncludes(sentinel.sources[1], "workflows");
    assertStringIncludes(sentinel.sources[2], "vaults");
  });
});

Deno.test("migrateConfigToDatastore: idempotent — second run returns alreadyMigrated", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");

    await ensureDir(join(repoDir, "models"));
    await Deno.writeTextFile(
      join(repoDir, "models", "test.yaml"),
      "content\n",
    );

    const first = await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "nonexistent.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );
    assertEquals(first.alreadyMigrated, false);
    assertEquals(first.copiedModels, true);

    const second = await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "nonexistent.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );
    assertEquals(second.alreadyMigrated, true);
    assertEquals(second.copiedModels, false);
  });
});

Deno.test("migrateConfigToDatastore: lockfile copied as file not directory", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "config");

    const lockfilePath = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(repoDir, "extensions", "models"));
    await Deno.writeTextFile(lockfilePath, '{"test": true}');

    const result = await migrateConfigToDatastore(
      repoDir,
      lockfilePath,
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );

    assertEquals(result.copiedLockfile, true);

    const stat = await Deno.stat(
      join(configRoot, "upstream_extensions.json"),
    );
    assertEquals(stat.isFile, true);

    const content = await Deno.readTextFile(
      join(configRoot, "upstream_extensions.json"),
    );
    assertEquals(content, '{"test": true}');
  });
});

Deno.test("getMigrationSentinelPath: returns correct path within configRoot", () => {
  const result = getMigrationSentinelPath("/repo/.swamp/config");
  assertEquals(
    result,
    join("/repo/.swamp/config", "managed-config-migrated.json"),
  );
});

Deno.test("migrateConfigToDatastore: creates configRoot directory if it does not exist", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await ensureDir(repoDir);
    const configRoot = join(dir, "deeply", "nested", "config");

    await migrateConfigToDatastore(
      repoDir,
      join(repoDir, "nonexistent.json"),
      configRoot,
      join(repoDir, ".swamp", "pulled-extensions"),
    );

    const stat = await Deno.stat(configRoot);
    assertEquals(stat.isDirectory, true);
  });
});
