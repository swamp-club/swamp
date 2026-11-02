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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  globalTelemetryDir,
  homeDirectory,
  SWAMP_SUBDIRS,
  swampPath,
} from "./paths.ts";
import { RepoMarkerRepository } from "./repo_marker_repository.ts";

/**
 * the caller skips opted-out repos, whose entries must never reach the global
 * spool or they would be sent despite the opt-out; flushed entries are left
 * behind
 */
export async function migrateRepoTelemetryToGlobal(
  repoDir: string,
  destDir: string = globalTelemetryDir(),
): Promise<number> {
  const sourceDir = swampPath(repoDir, SWAMP_SUBDIRS.telemetry);

  const sourceNames: string[] = [];
  try {
    for await (const entry of Deno.readDir(sourceDir)) {
      if (!entry.isFile) continue;
      if (!entry.name.startsWith("telemetry-")) continue;
      if (!entry.name.endsWith(".json")) continue;
      // Only unflushed entries (never sent). Flushed copies are left behind.
      if (entry.name.endsWith(".flushed.json")) continue;
      sourceNames.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }

  if (sourceNames.length === 0) return 0;
  await ensureDir(destDir);

  let migrated = 0;
  for (const name of sourceNames) {
    const src = join(sourceDir, name);
    const dest = join(destDir, name);
    try {
      await Deno.rename(src, dest);
    } catch {
      // Cross-filesystem move (repo and home on different mounts): rename
      // throws EXDEV, so fall back to copy-then-remove. A NotFound from
      // either step means a concurrent invocation already migrated the
      // file — skip it and keep draining the rest.
      try {
        await Deno.copyFile(src, dest);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      try {
        await Deno.remove(src);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    migrated++;
  }

  return migrated;
}

/**
 * skips silently when home is not a repo, its marker is unreadable (consent
 * unknown, entries stay put) or telemetry is disabled; never throws, since a
 * migration failure must not break the CLI
 */
export async function migrateHomeRepoTelemetry(
  homeDir?: string,
  destDir?: string,
): Promise<number> {
  try {
    const home = homeDir ?? homeDirectory();
    const marker = await new RepoMarkerRepository().read(RepoPath.create(home));
    if (marker === null) return 0;
    if (marker.telemetryDisabled === true) return 0;
    return await migrateRepoTelemetryToGlobal(
      home,
      destDir ?? globalTelemetryDir(),
    );
  } catch {
    return 0;
  }
}
