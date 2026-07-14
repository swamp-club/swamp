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
import { globalTelemetryDir, SWAMP_SUBDIRS, swampPath } from "./paths.ts";

/**
 * Migrates UNFLUSHED telemetry entries from a legacy repo-local spool
 * (`<repoDir>/.swamp/telemetry/`) to the single user-global spool.
 *
 * Telemetry became user-global, so a repo upgraded from an older layout may
 * still hold entries that were recorded but never sent. This moves them to the
 * global spool so they are not lost. Each file keeps its name (which embeds a
 * UUID, making collisions effectively impossible). Already-flushed entries
 * (`*.flushed.json`) were already sent and are left behind. The repo-local
 * directory itself is NOT removed — it is left orphaned.
 *
 * The caller is responsible for skipping repos that have opted out of
 * telemetry: a disabled repo's leftover entries must never be moved into the
 * global spool, or they would be sent despite the opt-out.
 *
 * @param repoDir - The repository root whose legacy spool should be drained.
 * @param destDir - The destination spool; defaults to the user-global spool.
 *   Injectable for tests.
 * @returns The number of entries migrated.
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
    if (error instanceof Deno.errors.NotFound) return 0; // no repo-local spool
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
      // throws EXDEV, so fall back to copy-then-remove.
      await Deno.copyFile(src, dest);
      await Deno.remove(src);
    }
    migrated++;
  }

  return migrated;
}
