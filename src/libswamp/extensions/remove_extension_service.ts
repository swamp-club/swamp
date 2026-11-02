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
import { findClaimants } from "../../domain/extensions/extension_path_claims.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import type { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { lockfileRelative } from "../../infrastructure/persistence/upstream_extensions.ts";
import {
  bundleNamespace,
  resolvePulledExtensionsRoot,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { pulledExtensionsLock } from "../../infrastructure/persistence/pulled_extensions_lock.ts";
import {
  assertNoBlockingJournal,
  recoverPulledExtensionStagingLocked,
} from "./recover_staging.ts";
import { UserError } from "../../domain/errors.ts";
import { inManagedLockfileTransaction } from "./managed_lockfile_transaction.ts";
import { PER_EXTENSION_SCAFFOLD_DIRS } from "./layout.ts";

/**
 * reason is the Deno error name, never the message, so no absolute path reaches
 * a serve client.
 */
export interface FailedFile {
  path: string;
  reason: string;
}

export interface RetainedFile {
  path: string;
  claimedBy: string[];
}

export interface RemoveExtensionResult {
  name: string;
  version: string;
  filesDeleted: number;
  filesSkipped: number;
  dirsRemoved: number;
  /**
   * tracked files left on disk because deleting them failed; the catalog and
   * lockfile do not track them, so the user has to remove them by hand
   */
  failedFiles: FailedFile[];
  /**
   * for a kept skill dir, the files this extension wrote there stay too and no
   * entry tracks them any more.
   */
  retainedFiles: RetainedFile[];
}

export type RemovePathFn = (
  path: string,
  options?: Deno.RemoveOptions,
) => Promise<void>;

/**
 * removal order is catalog, lockfile, filesystem, so a mid-rm crash leaves
 * files but a clean catalog, surfaced by findStaleFiles; paths are validated
 * before any write
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
   * runs under the pulled-extensions lock so it cannot interleave with an
   * install or removal; the lockfile snapshot is refreshed first so entries and
   * claims are those on disk
   */
  async execute(name: string): Promise<RemoveExtensionResult> {
    // a managed lockfile's transaction fetches the shared lockfile under the
    // datastore global lock first and publishes the removal after, so a removal
    // from a stale cache cannot revert other checkouts' entries.
    return await inManagedLockfileTransaction(
      this.lockfileRepository.lockfilePath,
      () =>
        pulledExtensionsLock.withLock(this.repoDir, async () => {
          await this.lockfileRepository.refresh();
          // Put right any install a crashed process left half done, so the
          // files removed are the ones the lockfile describes.
          const recovery = await recoverPulledExtensionStagingLocked(
            this.repoDir,
            { lockfilePaths: [this.lockfileRepository.lockfilePath] },
          );
          assertNoBlockingJournal(recovery, this.repoDir, name, "remove");
          return await this.removeLocked(name);
        }),
    );
  }

  private async removeLocked(name: string): Promise<RemoveExtensionResult> {
    // both the catalog and the lockfile must confirm absence before this counts
    // as not installed; either being non-empty means there is cleanup to do.
    const extensions = this.repository.loadByName(name);
    const lockfileEntry = this.lockfileRepository.getEntry(name);
    if (extensions.length === 0 && lockfileEntry === null) {
      throw new UserError(`Extension ${name} is not installed.`);
    }

    const version = lockfileEntry?.version ?? extensions[0]?.version ?? "";
    const trackedFiles = lockfileEntry?.files ?? [];
    // Read the other entries' claims before this entry is removed. A
    // skill dir lives in a shared tool dir, so another extension may
    // have merged its files into it; deleting it recursively would take
    // those files too.
    const otherEntries = this.lockfileRepository.getAllEntries();

    // validate every tracked path before changing anything: a path outside the
    // repo would otherwise fail mid-delete, after the catalog and lockfile had
    // forgotten the extension.
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

    // catalog tombstone-save first: one SQLite transaction deletes every row
    // this extension owns. A crash before the lockfile write leaves the catalog
    // clean and the next loader pass surfaces the rest via findStaleFiles.
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

    if (lockfileEntry !== null) {
      await this.lockfileRepository.removeEntry(name);
    }

    // last step: the catalog and lockfile have already forgotten this
    // extension, so a failed delete is recorded and the loop carries on rather
    // than leaving files half-removed.
    let filesDeleted = 0;
    let filesSkipped = 0;
    const failedFiles: FailedFile[] = [];
    const retainedFiles: RetainedFile[] = [];
    const parentDirs: string[] = [];
    for (const filePath of trackedFiles) {
      const claimedBy = findClaimants(filePath, name, otherEntries);
      if (claimedBy.length > 0) {
        retainedFiles.push({ path: filePath, claimedBy });
        continue;
      }
      const absolutePath = join(this.repoDir, filePath);
      try {
        // lstat so a symlinked path is unlinked, never treated as the
        // directory it points to.
        const stat = await Deno.lstat(absolutePath);
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

    // pull creates these scaffold subdirs unconditionally and never records
    // them as tracked files, so push them or pruneEmptyDirs would see them as
    // non-empty. Where absent (legacy installs), its NotFound is absorbed.
    const extensionRoot = join(
      this.pulledExtensionsRoot,
      name,
    );
    for (const scaffoldDir of PER_EXTENSION_SCAFFOLD_DIRS) {
      parentDirs.push(join(extensionRoot, scaffoldDir));
    }

    // the lockfile does not list bundle files (their namespace hash differs
    // between OSes) and each namespace holds only this extension's bundles, so
    // delete the namespace dirs pull creates.
    const BUNDLE_MAPPINGS: ReadonlyArray<[string, string]> = [
      ["models", "bundles"],
      ["vaults", "vault-bundles"],
      ["datastores", "datastore-bundles"],
      ["reports", "report-bundles"],
      ["webhooks", "webhook-bundles"],
    ];
    let bundleDirsRemoved = 0;
    for (const [sourceKind, bundleKind] of BUNDLE_MAPPINGS) {
      const kindDir = swampPath(this.repoDir, bundleKind);
      const namespaceDir = join(
        kindDir,
        bundleNamespace(join(extensionRoot, sourceKind), this.repoDir),
      );
      try {
        const stat = await Deno.lstat(namespaceDir);
        await this.removePath(namespaceDir, { recursive: stat.isDirectory });
        bundleDirsRemoved++;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          failedFiles.push({
            path: lockfileRelative(this.repoDir, namespaceDir),
            reason: error instanceof Error ? error.name : "Error",
          });
        }
      }
      parentDirs.push(kindDir);
    }

    const dirsRemoved = bundleDirsRemoved +
      await pruneEmptyDirs(parentDirs, this.repoDir);

    return {
      name,
      version,
      filesDeleted,
      filesSkipped,
      dirsRemoved,
      failedFiles,
      retainedFiles,
    };
  }
}

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
