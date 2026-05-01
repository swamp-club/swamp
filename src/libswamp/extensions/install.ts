// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { join } from "@std/path";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import { cleanupEmptyParentDirs } from "../../infrastructure/persistence/directory_cleanup.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type ExtensionRef,
  type InstallContext,
  installExtension,
  type InstallResult,
  parseExtensionRef,
} from "./pull.ts";
import { classifyExtensionFile } from "./layout.ts";

/**
 * Test seam for `extensionInstall`. Production always uses
 * `installExtension` from pull.ts; tests inject a stub that simulates
 * the side effects (writing to the per-extension subtree and updating
 * the lockfile) without needing a real tar archive and registry.
 *
 * Returns the same shape as `installExtension`: an `InstallResult` on
 * a fresh install, or `undefined` when the extension was already pulled
 * earlier in the same call chain (the alreadyPulled short-circuit).
 * The result's `pruned` field carries the paths actually removed during
 * orphan cleanup so callers can surface that to the user.
 */
export type InstallExtensionFn = (
  ref: ExtensionRef,
  ctx: InstallContext,
) => Promise<InstallResult | undefined>;

/** Result of installing a single extension during bulk install. */
export interface ExtensionInstallEntry {
  name: string;
  version: string;
  status: "installed" | "migrated" | "up_to_date" | "failed";
  error?: string;
}

/** Data for the completed event. */
export interface ExtensionInstallData {
  entries: ExtensionInstallEntry[];
  installed: number;
  migrated: number;
  upToDate: number;
  failed: number;
}

export type ExtensionInstallEvent =
  | { kind: "resolving" }
  | { kind: "installing"; name: string; version: string }
  | { kind: "migrating"; name: string; version: string }
  | {
    kind: "orphans-pruned";
    name: string;
    version: string;
    paths: string[];
  }
  | { kind: "completed"; data: ExtensionInstallData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the extension install operation. */
export interface ExtensionInstallDeps {
  lockfilePath: string;
  repoDir: string;
  createInstallContext: (
    name: string,
    version: string,
  ) => InstallContext;
  /**
   * Test seam. Defaults to the real `installExtension` from pull.ts;
   * tests can inject a stub so they don't need a real tar archive and
   * registry to exercise the success path.
   */
  installExtensionFn?: InstallExtensionFn;
}

/**
 * Reads upstream_extensions.json and re-pulls any extensions whose files
 * are either missing from disk or still sit at a legacy on-disk layout
 * (gen-1 `extensions/<type>/…` or gen-2 flat
 * `.swamp/pulled-extensions/<type>/…`). Analogous to `npm install` but
 * also performs layout migration on legacy repos — a single call brings
 * the repo to the current per-extension subtree layout.
 *
 * For legacy-layout entries, the per-entry flow is: capture the original
 * `files[]` list BEFORE install (installExtension rewrites the lockfile
 * to current-layout paths on success, so the legacy list must be
 * snapshotted first); call installExtension to write the new layout;
 * then sweep the original legacy paths so the working tree no longer
 * carries duplicates.
 */
export async function* extensionInstall(
  _ctx: LibSwampContext,
  deps: ExtensionInstallDeps,
): AsyncIterable<ExtensionInstallEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.install",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const upstream = await readUpstreamExtensions(deps.lockfilePath);
      const entries: ExtensionInstallEntry[] = [];
      let installed = 0;
      let migrated = 0;
      let upToDate = 0;
      let failed = 0;

      for (const [name, entry] of Object.entries(upstream)) {
        const version = entry.version;
        const originalFiles = entry.files ?? [];

        // Decide whether this entry needs work. An entry needs install
        // when any of its files are absent from disk, OR when any are at
        // a legacy layout (gen-1 or gen-2) and must be migrated to the
        // current per-extension subtree.
        const needs = await needsInstallOrMigration(
          originalFiles,
          deps.repoDir,
        );

        if (needs === "up_to_date") {
          entries.push({ name, version, status: "up_to_date" });
          upToDate++;
          continue;
        }

        yield needs === "migrate"
          ? { kind: "migrating", name, version }
          : { kind: "installing", name, version };

        try {
          const installCtx = deps.createInstallContext(name, version);
          // Thread the lockfile's stored checksum through as an integrity
          // anchor. installExtension verifies the freshly-downloaded archive
          // matches byte-for-byte and fails loudly on registry drift.
          // Pre-checksum-tracking entries (pre-f4dfc083) have no stored
          // value and skip verification (handled in installExtension).
          if (entry.checksum) {
            installCtx.expectedChecksum = entry.checksum;
          }
          const ref = parseExtensionRef(`${name}@${version}`);
          const install = deps.installExtensionFn ?? installExtension;
          const result = await install(ref, installCtx);

          // For migrations, sweep the original legacy paths now that the
          // current-layout files are on disk. installExtension has already
          // rewritten entry.files in the lockfile to point at the new
          // locations, so the legacy paths are "orphaned" and safe to
          // remove.
          if (needs === "migrate") {
            await sweepLegacyPaths(originalFiles, deps.repoDir);
            entries.push({ name, version, status: "migrated" });
            migrated++;
          } else {
            entries.push({ name, version, status: "installed" });
            installed++;
          }

          // Surface orphan removals to the user. Source-of-truth list
          // is `result.pruned` (paths actually removed by
          // pruneOrphanFiles inside installExtension), not the diff
          // we'd compute here. When the test seam returns undefined or
          // the install was a no-op (alreadyPulled), there's nothing
          // to emit.
          if (result && result.pruned.length > 0) {
            yield {
              kind: "orphans-pruned",
              name,
              version,
              paths: result.pruned,
            };
          }
        } catch (error) {
          entries.push({
            name,
            version,
            status: "failed",
            error: String(error),
          });
          failed++;
        }
      }

      yield {
        kind: "completed",
        data: { entries, installed, migrated, upToDate, failed },
      };
    })(),
  );
}

/**
 * Decides whether an entry's on-disk state matches the current layout.
 *
 * - Returns `"install"` when any file is missing from disk.
 * - Returns `"migrate"` when all files exist but at least one is at a
 *   legacy layout (gen-1 or gen-2); install will re-pull into the
 *   per-extension subtree and the caller sweeps the legacy paths.
 * - Returns `"up_to_date"` when every file exists AND is already at the
 *   current layout.
 *
 * Missing beats legacy: a missing file cannot be migrated without a
 * re-pull, so the flow is the same either way.
 */
export async function needsInstallOrMigration(
  files: string[],
  repoDir: string,
): Promise<"install" | "migrate" | "up_to_date"> {
  let hasLegacy = false;
  for (const file of files) {
    const absolutePath = join(repoDir, file);
    try {
      await Deno.stat(absolutePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return "install";
      }
      throw error;
    }
    const generation = classifyExtensionFile(file);
    if (generation !== "current") {
      hasLegacy = true;
    }
  }
  return hasLegacy ? "migrate" : "up_to_date";
}

/**
 * Removes legacy-layout files left behind after a successful migration
 * re-pull. Only paths classified as gen-1 or gen-2 are removed; current-
 * layout paths are left alone. NotFound is tolerated (file already gone
 * from an interrupted prior pass). Empty parent directories under the
 * repo root are pruned.
 *
 * Uses recursive removal so directory entries (e.g. legacy skill dirs
 * tracked by their root, with nested files inside) are handled — a plain
 * Deno.remove fails on non-empty directories.
 *
 * Exported for direct unit testing; production callers invoke it
 * indirectly through `extensionInstall`.
 */
export async function sweepLegacyPaths(
  originalFiles: string[],
  repoDir: string,
): Promise<void> {
  for (const file of originalFiles) {
    if (classifyExtensionFile(file) === "current") {
      continue;
    }
    const absolutePath = join(repoDir, file);
    try {
      await Deno.remove(absolutePath, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    await cleanupEmptyParentDirs(absolutePath, repoDir);
  }
}
