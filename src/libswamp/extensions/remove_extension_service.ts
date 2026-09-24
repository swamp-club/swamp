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

import { dirname, join, resolve } from "@std/path";
import {
  assertContainedPath,
  PathTraversalError,
} from "../../infrastructure/persistence/safe_path.ts";
import { tombstoneAll } from "../../domain/extensions/extension.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  bundleNamespace,
  resolvePulledExtensionsRoot,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { UserError } from "../../domain/errors.ts";
import { PER_EXTENSION_SCAFFOLD_DIRS } from "./layout.ts";

/**
 * A tracked file that `extension rm` could not delete. `reason` is the
 * Deno error name (e.g. `PermissionDenied`), never the error message,
 * so no absolute path reaches a serve client.
 */
export interface FailedFile {
  path: string;
  reason: string;
}

/** Result of `RemoveExtensionService.execute()`. */
export interface RemoveExtensionResult {
  name: string;
  version: string;
  filesDeleted: number;
  filesSkipped: number;
  dirsRemoved: number;
  /**
   * Tracked files left on disk because deleting them failed. The
   * catalog and lockfile no longer track them, so the user has to
   * remove them by hand.
   */
  failedFiles: FailedFile[];
}

/** Removes a filesystem path. Defaults to `Deno.remove`. */
export type RemovePathFn = (
  path: string,
  options?: Deno.RemoveOptions,
) => Promise<void>;

/**
 * W2 lifecycle service for removing an installed extension. **Closes
 * swamp-club#201**: today's `extension rm` does not touch the catalog
 * at all, leaving stale `(kind, type)` rows that survive removal. This
 * service makes the catalog write the FIRST step of removal so the
 * Extension aggregate is gone before any other state is touched.
 *
 * **Asymmetric ordering with `InstallExtensionService`.** Install is
 * filesystem → lockfile → catalog. Remove is the **inverse**: catalog
 * → lockfile → filesystem. The architecture-agent's "expensive miss
 * #1": if rm went FS-first, the catalog would briefly point at deleted
 * bundles and resolution would crash for that window. Catalog-first
 * means a mid-rm crash leaves files on disk but the catalog clean — the
 * next loader pass surfaces the orphans via the existing
 * `findStaleFiles` fallback. Pinned in plan v4.
 *
 * **Validate before mutating.** Every tracked path is checked before
 * the catalog write, so a path outside the repo fails the rm with
 * nothing changed and a retry still sees the extension installed.
 * Once the catalog and lockfile are updated, a file that cannot be
 * deleted is reported in `failedFiles` instead of aborting the rm
 * halfway (swamp-club#2489).
 *
 * **Idempotency.** A double-rm yields a clean `UserError("not
 * installed")` on the second call, NOT silent success and NOT an
 * ambiguous error. Pin in plan v4 challenge #9.
 *
 * **Tombstoned-row interaction.** An extension with leftover
 * `Tombstoned` Sources from a prior failed upgrade can still be rm'd
 * cleanly — `tombstoneAll()` is idempotent (already-tombstoned Sources
 * stay tombstoned).
 *
 * **W4-inherits.** The service shape is W4-stable. Future cleanup is
 * just "delete the service" if/when the catalog-write boundary is
 * unified into a single lifecycle layer.
 */
export class RemoveExtensionService {
  private readonly repository: ExtensionRepository;
  private readonly lockfileRepository: LockfileRepository;
  private readonly repoDir: string;
  private readonly pulledExtensionsRoot: string;
  private readonly removePath: RemovePathFn;

  constructor(args: {
    repository: ExtensionRepository;
    lockfileRepository: LockfileRepository;
    repoDir: string;
    pulledExtensionsRoot?: string;
    /** Test seam. Defaults to `Deno.remove`. */
    removePath?: RemovePathFn;
  }) {
    this.repository = args.repository;
    this.lockfileRepository = args.lockfileRepository;
    this.repoDir = args.repoDir;
    this.pulledExtensionsRoot = args.pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(this.repoDir);
    this.removePath = args.removePath ?? Deno.remove;
  }

  /**
   * Removes the extension named `name`. Throws {@link UserError} if
   * `name` is not installed, or if any tracked path resolves outside
   * the repo (nothing is changed in that case). Returns counts of
   * files deleted, skipped (already-missing), and parent directories
   * pruned, plus the files that could not be deleted.
   *
   * Ordering: path validation → catalog tombstone-save → lockfile
   * remove → filesystem delete → empty-dir prune.
   */
  async execute(name: string): Promise<RemoveExtensionResult> {
    // 1. Idempotency check — surface a clean error if the extension
    //    isn't installed. Both the catalog AND the lockfile must
    //    confirm absence before we treat it as not-installed; either
    //    one being non-empty means there's still cleanup to do.
    const extensions = this.repository.loadByName(name);
    const lockfileEntry = this.lockfileRepository.getEntry(name);
    if (extensions.length === 0 && lockfileEntry === null) {
      throw new UserError(`Extension ${name} is not installed.`);
    }

    const version = lockfileEntry?.version ?? extensions[0]?.version ?? "";
    const trackedFiles = lockfileEntry?.files ?? [];

    // 1b. Validate every tracked path before changing anything. A path
    //     outside the repo (e.g. a pre-.swamp lockfile written with
    //     SWAMP_MODELS_DIR outside the repo) would otherwise fail
    //     mid-delete, after the catalog and lockfile had already
    //     forgotten the extension.
    const uncontained: string[] = [];
    for (const filePath of trackedFiles) {
      try {
        assertContainedPath(filePath, this.repoDir);
      } catch (error) {
        if (!(error instanceof PathTraversalError)) throw error;
        uncontained.push(filePath);
      }
    }
    if (uncontained.length > 0) {
      throw new UserError(
        `Extension ${name} lists ${uncontained.length} path(s) outside ` +
          `the repository in upstream_extensions.json (first: ` +
          `${uncontained[0]}). Nothing was removed. Delete those paths ` +
          `from the extension's "files" list, then retry ` +
          `\`swamp extension rm ${name}\`.`,
      );
    }

    // 2. Catalog tombstone-save FIRST. saveAll([tombstoneAll(ext)])
    //    DELETEs every row owned by this extension in one SQLite
    //    transaction. If the process crashes between this step and
    //    the lockfile write, the catalog is clean but the lockfile +
    //    filesystem still hold the extension — the next loader pass
    //    surfaces them via findStaleFiles.
    if (extensions.length > 0) {
      try {
        this.repository.saveAll(extensions.map(tombstoneAll));
      } catch (error) {
        // SQLite ROLLBACK kept the catalog in its pre-rm state, so a
        // retry is a clean re-rm. Surface a UserError so log-mode
        // shows the guidance without a stack trace.
        throw new UserError(
          `Remove failed for ${name} during catalog write ` +
            `(${
              error instanceof Error ? error.message : String(error)
            }). The catalog was rolled back; the extension is unchanged. ` +
            `Retry \`swamp extension rm ${name}\`.`,
        );
      }
    }

    // 3. Lockfile remove. Cache + disk both flush in writeEntry's
    //    re-read-under-lock path.
    if (lockfileEntry !== null) {
      await this.lockfileRepository.removeEntry(name);
    }

    // 4. Filesystem delete. Last step — by the time we get here the
    //    catalog and lockfile have already forgotten this extension,
    //    so a failed delete is recorded and the loop carries on
    //    rather than leaving the remaining files half-removed.
    let filesDeleted = 0;
    let filesSkipped = 0;
    const failedFiles: FailedFile[] = [];
    const parentDirs: string[] = [];
    for (const filePath of trackedFiles) {
      const absolutePath = join(this.repoDir, filePath);
      try {
        const stat = await Deno.stat(absolutePath);
        await this.removePath(absolutePath, { recursive: stat.isDirectory });
        filesDeleted++;
        parentDirs.push(dirname(absolutePath));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          filesSkipped++;
        } else {
          failedFiles.push({
            path: filePath,
            reason: error instanceof Error ? error.name : "Error",
          });
        }
      }
    }

    // 5. Add the per-extension scaffold subdirs that `pull` creates
    //    unconditionally — they are never recorded as tracked files,
    //    so without this push `pruneEmptyDirs` would see them as
    //    "non-empty entries" when walking up through the extension
    //    root and bail. For legacy gen-1 / gen-2 installs these paths
    //    don't exist on disk; `pruneEmptyDirs`'s `try/catch` around
    //    `Deno.readDir` absorbs the resulting `NotFound` safely, so
    //    the push is unconditional.
    const extensionRoot = join(
      this.pulledExtensionsRoot,
      name,
    );
    for (const scaffoldDir of PER_EXTENSION_SCAFFOLD_DIRS) {
      parentDirs.push(join(extensionRoot, scaffoldDir));
    }

    // 6. Add the bundle namespace dirs that `pull` creates
    //    unconditionally for each per-extension kind dir. These are
    //    never recorded as tracked files when the extension ships no
    //    content for that bundle kind — same shape as the scaffold-dir
    //    fix above. Maps source kind → top-level bundle kind, matching
    //    the bundle mkdir+copyDir pairs in pull.ts.
    const BUNDLE_MAPPINGS: ReadonlyArray<[string, string]> = [
      ["models", "bundles"],
      ["vaults", "vault-bundles"],
      ["datastores", "datastore-bundles"],
      ["reports", "report-bundles"],
      ["webhooks", "webhook-bundles"],
    ];
    for (const [sourceKind, bundleKind] of BUNDLE_MAPPINGS) {
      parentDirs.push(
        join(
          swampPath(this.repoDir, bundleKind),
          bundleNamespace(join(extensionRoot, sourceKind), this.repoDir),
        ),
      );
    }

    // 7. Prune empty parent directories up to (but not including)
    //    the repo root.
    const dirsRemoved = await pruneEmptyDirs(parentDirs, this.repoDir);

    return {
      name,
      version,
      filesDeleted,
      filesSkipped,
      dirsRemoved,
      failedFiles,
    };
  }
}

/**
 * Removes empty parent directories up to (but not including) the
 * stop directory. Returns the number of directories removed. Walks
 * upward, deepest-first; stops at the first non-empty directory.
 */
async function pruneEmptyDirs(
  dirs: string[],
  stopDir: string,
): Promise<number> {
  let removed = 0;
  const resolvedStop = resolve(stopDir);
  const sorted = [...new Set(dirs)].sort((a, b) => b.length - a.length);

  for (const dir of sorted) {
    let current = resolve(dir);
    while (current.length > resolvedStop.length && current !== resolvedStop) {
      try {
        const entries: Deno.DirEntry[] = [];
        for await (const entry of Deno.readDir(current)) {
          entries.push(entry);
        }
        if (entries.length === 0) {
          await Deno.remove(current);
          removed++;
          current = dirname(current);
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  return removed;
}
