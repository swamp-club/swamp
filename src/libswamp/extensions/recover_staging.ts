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

import { resolve } from "@std/path";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import {
  blockingLeftJournals,
  type InstallFsOps,
  recoverInstallStaging,
  type StagingRecoveryReport,
} from "../../infrastructure/persistence/extension_install_transaction.ts";
import { resolveExtensionLockfilePaths } from "../../infrastructure/persistence/extension_lockfile_paths.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  EXTENSION_BUNDLE_KINDS,
  extensionInstallRoots,
  resolvePulledExtensionsRoot,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { pulledExtensionsLock } from "../../infrastructure/persistence/pulled_extensions_lock.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";

export type { StagingRecoveryReport };

/** Options for {@link recoverPulledExtensionStaging}. */
export interface RecoverStagingOptions {
  /**
   * Lockfile paths to accept on top of the ones derived from the repo
   * marker, e.g. the lockfile the calling install or removal already
   * uses.
   */
  lockfilePaths?: ReadonlyArray<string>;
  /** Test seam: the clock the stale-staging sweep reads. */
  now?: () => number;
  /** Test seam: the filesystem operations recovery performs. */
  ops?: InstallFsOps;
}

/**
 * Finishes or undoes every extension install a crashed process left
 * half done in this checkout, and sweeps stale staging. Each install
 * writes a journal before it moves anything; recovery rolls it forward
 * when its swap completed and its lockfile entry landed, otherwise back,
 * deciding each root from what its staging dir holds. An invalid journal
 * is left in place with a warning naming it.
 *
 * Takes the pulled-extensions lock (running inline when the caller holds
 * it). For convergence and other callers outside an install or removal.
 */
export async function recoverPulledExtensionStaging(
  repoDir: string,
  options: RecoverStagingOptions = {},
): Promise<StagingRecoveryReport> {
  return await pulledExtensionsLock.withLock(
    repoDir,
    () => recoverPulledExtensionStagingLocked(repoDir, options),
  );
}

/**
 * {@link recoverPulledExtensionStaging} for a caller that already holds
 * the pulled-extensions lock: installs at the start of every apply, and
 * removals before they change anything.
 */
export async function recoverPulledExtensionStagingLocked(
  repoDir: string,
  options: RecoverStagingOptions = {},
): Promise<StagingRecoveryReport> {
  repoDir = resolve(repoDir);
  const marker = await readMarker(repoDir);
  const allowedLockfilePaths = [
    ...resolveExtensionLockfilePaths(repoDir, marker),
    ...(options.lockfilePaths ?? []),
  ];
  return await recoverInstallStaging({
    bounds: {
      pulledRoot: resolvePulledExtensionsRoot(repoDir),
      allowedLockfilePaths,
      expectedLivePaths: (name) => {
        const roots = extensionInstallRoots(repoDir, name);
        return {
          extensionRoot: roots.extensionRoot,
          bundleRoots: roots.bundleRoots.map((r) => r.live),
        };
      },
    },
    bundleKindDirs: EXTENSION_BUNDLE_KINDS.map(({ bundleKind }) =>
      swampPath(repoDir, bundleKind)
    ),
    readLockfileChecksum: async (lockfilePath, name) =>
      (await LockfileRepository.create(lockfilePath)).getEntry(name)
        ?.checksum ?? null,
    now: options.now,
    ops: options.ops,
  });
}

/**
 * Refuses to change extension `name` while crash recovery left a journal
 * behind for it, or for an extension nested in or above it: their roots
 * overlap, and a later recovery of that journal could act on files this
 * change wrote.
 */
export function assertNoBlockingJournal(
  recovery: StagingRecoveryReport,
  name: string,
  action: "install" | "remove",
): void {
  const blocking = blockingLeftJournals(recovery, name);
  if (blocking.length === 0) return;
  const [first] = blocking;
  throw new UserError(
    `Cannot ${action} ${name}: an earlier install of ` +
      `${first.extensionName} was interrupted and could not be put right ` +
      `(${first.reason}). Its journal is ${first.journalPath}. Fix the ` +
      `cause and retry, or, after checking that ` +
      `.swamp/pulled-extensions/${first.extensionName} holds the version ` +
      `you want, delete the journal's directory and retry.`,
  );
}

async function readMarker(repoDir: string): Promise<RepoMarkerData | null> {
  try {
    return await new RepoMarkerRepository().read(RepoPath.create(repoDir));
  } catch {
    // No readable marker: the default lockfile locations still apply.
    return null;
  }
}
