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

import { copy, ensureDir } from "@std/fs";
import { dirname, join, resolve } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { isStagingEntryName } from "../extensions/install_journal.ts";

const logger = getLogger(["swamp", "datastore", "managed-config-migration"]);

/** The file a config tier holds once a migration into it is published. */
export const MIGRATION_SENTINEL = "managed-config-migrated.json";

export interface MigrationResult {
  copiedModels: boolean;
  copiedWorkflows: boolean;
  copiedVaults: boolean;
  copiedLockfile: boolean;
  copiedPulledExtensions: boolean;
  alreadyMigrated: boolean;
  /** The source paths the migration copies from, for the sentinel. */
  sources: readonly string[];
}

/**
 * Copies config into the config tier unless its migration sentinel exists.
 * The sentinel is not written here: the caller writes it with
 * {@link writeMigrationSentinel} once the copied files are published, so a
 * datastore's sentinel always means its migration is published
 * (swamp-club#3117).
 */
export async function migrateConfigToDatastore(
  repoDir: string,
  lockfileSourcePath: string,
  configRoot: string,
  pulledExtensionsSource: string,
): Promise<MigrationResult> {
  const sentinelPath = join(configRoot, MIGRATION_SENTINEL);

  try {
    await Deno.stat(sentinelPath);
    logger.info`Config migration already completed (sentinel exists)`;
    return {
      copiedModels: false,
      copiedWorkflows: false,
      copiedVaults: false,
      copiedLockfile: false,
      copiedPulledExtensions: false,
      alreadyMigrated: true,
      sources: [],
    };
  } catch {
    // Sentinel doesn't exist — proceed with migration
  }

  await ensureDir(configRoot);

  const result: MigrationResult = {
    copiedModels: false,
    copiedWorkflows: false,
    copiedVaults: false,
    copiedLockfile: false,
    copiedPulledExtensions: false,
    alreadyMigrated: false,
    sources: [],
  };

  const sources: Array<{
    src: string;
    dest: string;
    key: Exclude<keyof MigrationResult, "sources">;
    isFile?: boolean;
  }> = [
    {
      src: join(repoDir, "models"),
      dest: join(configRoot, "models"),
      key: "copiedModels",
    },
    {
      src: join(repoDir, "workflows"),
      dest: join(configRoot, "workflows"),
      key: "copiedWorkflows",
    },
    {
      src: join(repoDir, "vaults"),
      dest: join(configRoot, "vaults"),
      key: "copiedVaults",
    },
    {
      src: resolve(lockfileSourcePath),
      dest: join(configRoot, "upstream_extensions.json"),
      key: "copiedLockfile",
      isFile: true,
    },
    {
      src: pulledExtensionsSource,
      dest: join(configRoot, "pulled-extensions"),
      key: "copiedPulledExtensions",
    },
  ];

  for (const { src, dest, key, isFile } of sources) {
    try {
      const stat = await Deno.stat(src);
      if (isFile ? stat.isFile : stat.isDirectory) {
        if (isFile) {
          await ensureDir(dirname(dest));
          await Deno.copyFile(src, dest);
        } else if (key === "copiedPulledExtensions") {
          await copyPulledExtensions(src, dest);
        } else {
          await copy(src, dest, { overwrite: true });
        }
        result[key] = true;
        logger.info`Copied ${src} → ${dest}`;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        logger.debug`Skipping ${src} (not found)`;
      } else {
        throw error;
      }
    }
  }

  return { ...result, sources: sources.map((s) => s.src) };
}

/** Writes the migration sentinel into `configRoot`. */
export async function writeMigrationSentinel(
  configRoot: string,
  sources: readonly string[],
): Promise<void> {
  await ensureDir(configRoot);
  await Deno.writeTextFile(
    join(configRoot, MIGRATION_SENTINEL),
    JSON.stringify({ migratedAt: new Date().toISOString(), sources }),
  );
}

export function getMigrationSentinelPath(configRoot: string): string {
  return join(configRoot, MIGRATION_SENTINEL);
}

/** Config tier subdirectories that hold definitions. */
const DEFINITION_SUBDIRS = ["models", "workflows", "vaults"] as const;

/**
 * Whether a config tier holds config: the migration sentinel, or any model,
 * workflow or vault definition. The sentinel alone is not enough, because
 * managedConfig can be switched on in `.swamp.yaml` by hand and definitions
 * then created directly in a tier that was never migrated (swamp-club#2845).
 * A missing `configRoot` is an empty tier.
 */
export async function isConfigTierPopulated(
  configRoot: string,
): Promise<boolean> {
  try {
    if ((await Deno.stat(join(configRoot, MIGRATION_SENTINEL))).isFile) {
      return true;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  for (const subdir of DEFINITION_SUBDIRS) {
    try {
      for await (const _ of Deno.readDir(join(configRoot, subdir))) {
        return true;
      }
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.NotADirectory)
      ) {
        throw error;
      }
    }
  }
  return false;
}

/**
 * Copies the pulled-extensions root extension by extension, leaving out
 * install staging: an interrupted install's journal names paths under the
 * root it was written in, so it stays there for crash recovery. Each
 * extension's earlier copy is removed first: a re-run after a failed push
 * copies again, and an extension's read-only `manifest.yaml` cannot be
 * overwritten (swamp-club#3117). Only this repo's extensions are replaced;
 * others in the same `@scope` directory are left as they are.
 */
async function copyPulledExtensions(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  for await (const entry of Deno.readDir(src)) {
    if (isStagingEntryName(entry.name)) continue;
    if (entry.name.startsWith("@") && entry.isDirectory) {
      await ensureDir(join(dest, entry.name));
      for await (const extension of Deno.readDir(join(src, entry.name))) {
        await replaceCopy(
          join(src, entry.name, extension.name),
          join(dest, entry.name, extension.name),
        );
      }
    } else {
      await replaceCopy(join(src, entry.name), join(dest, entry.name));
    }
  }
}

async function replaceCopy(src: string, dest: string): Promise<void> {
  await Deno.remove(dest, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await copy(src, dest);
}
