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

import { dirname, join, relative, resolve } from "@std/path";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import {
  blockingLeftJournals,
  type InstallFsOps,
  type LeftJournal,
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

export interface RecoverStagingOptions {
  /**
   * lockfile paths accepted on top of those derived from the repo marker, such
   * as the one the calling install or removal already uses.
   */
  lockfilePaths?: ReadonlyArray<string>;
  /** Test seam: the clock the stale-staging sweep reads. */
  now?: () => number;
  /** Test seam: the filesystem operations recovery performs. */
  ops?: InstallFsOps;
}

/**
 * each install writes a journal before moving anything; recovery rolls it
 * forward when its swap completed and its lockfile entry landed, otherwise
 * back. An invalid journal is left in place with a warning naming it.
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
      repoDir,
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
 * their roots overlap, so a later recovery of that journal could act on files
 * this change wrote. The advice follows where the interrupted extension's
 * copies are, so it never says to delete the only copy.
 */
export function assertNoBlockingJournal(
  recovery: StagingRecoveryReport,
  repoDir: string,
  name: string,
  action: "install" | "remove",
): void {
  const blocking = blockingLeftJournals(recovery, name);
  if (blocking.length === 0) return;
  const [first] = blocking;
  const shown = (path: string) => relative(resolve(repoDir), path);
  throw new UserError(
    `Cannot ${action} ${name}: an earlier install of ` +
      `${first.extensionName} was interrupted and could not be put right ` +
      `(${first.reason}). Fix the cause and retry, or put it right by ` +
      `hand: ` +
      recoveryAdvice(first, repoDir, name, shown),
  );
}

function recoveryAdvice(
  left: LeftJournal,
  repoDir: string,
  name: string,
  shown: (path: string) => string,
): string {
  const extension = left.extensionName ?? name;
  const staging = shown(dirname(left.journalPath));
  const copies = left.extensionRoot;
  if (!copies) {
    const live = join(resolvePulledExtensionsRoot(resolve(repoDir)), extension);
    return `check ${shown(join(dirname(left.journalPath), "old"))} before ` +
      `deleting ${staging}: it may hold the only copy of ${extension}'s ` +
      `previous version, which belongs at ${shown(live)}.`;
  }
  const live = shown(copies.live);
  const old = shown(copies.old);
  const hasOld = copies.oldState !== "absent";
  const hasLive = copies.liveState !== "absent";
  if (hasOld && !hasLive) {
    return `the previous version of ${extension} is in ${old} and ${live} ` +
      `is missing: move ${old} to ${live}, then delete ${staging} and retry.`;
  }
  if (hasOld) {
    return `the previous version of ${extension} is in ${old}, and ${live} ` +
      `may hold a partly installed one. Keep the version you want at ` +
      `${live}, then delete ${staging} and retry.`;
  }
  if (hasLive) {
    return `once you have checked that ${live} holds the version you ` +
      `want, delete ${staging} and retry.`;
  }
  return `no copy of ${extension} is left at ${live} or in ${old}: ` +
    `delete ${staging}, then pull ${extension} again.`;
}

async function readMarker(repoDir: string): Promise<RepoMarkerData | null> {
  try {
    return await new RepoMarkerRepository().read(RepoPath.create(repoDir));
  } catch {
    // No readable marker: the default lockfile locations still apply.
    return null;
  }
}
