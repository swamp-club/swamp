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

import { join } from "@std/path";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  type InstalledEntries,
  isAbsentFromDisk,
  pathsToRemoveForReinstall,
  readInstalledEntries,
} from "../../infrastructure/persistence/installed_entries.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { readManifestIdentityAt } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { isVersionConstraint } from "./pull.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** A single extension entry for list output. */
export interface ExtensionListEntry {
  name: string;
  version: string;
  pulledAt: string;
  files: string[];
  channel?: string;
  /**
   * The version in the extension's on-disk manifest, present only when it
   * differs from the lockfile's pinned `version`: the loaded code is not
   * what the lockfile pins.
   */
  onDiskVersion?: string;
  /**
   * Present when the entry comes only from the transitional in-repo
   * auto-resolve lockfile (swamp-club#2483), not the team's lockfile.
   */
  autoResolved?: true;
  /**
   * On an auto-resolved entry: the repo-relative paths to delete so the
   * auto-resolver reinstalls it (its directory and any pulled skill dirs).
   */
  removeToReinstall?: string[];
}

/** Data payload for the completed event. */
export interface ExtensionListData {
  extensions: ExtensionListEntry[];
}

export type ExtensionListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionListData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the extension list operation. */
export interface ExtensionListDeps {
  /**
   * Lockfile repository pre-constructed by the caller. Captures a
   * snapshot of upstream_extensions.json at construction.
   */
  lockfileRepository: LockfileRepository;
  /**
   * Reads the version of an extension from its on-disk manifest, or null
   * when unknown. Used to flag lockfile/disk version skew.
   */
  readOnDiskVersion?: (name: string) => string | null;
  /** Names found only in the transitional in-repo auto-resolve lockfile. */
  autoResolvedNames?: ReadonlySet<string>;
  /** The paths to delete so an auto-resolved extension is reinstalled. */
  removeToReinstall?: (name: string) => string[];
}

/** Retry delay for a lockfile caught mid-rewrite. */
const LOCKFILE_RETRY_DELAY_MS = 75;

const waitBeforeRetryDefault = () =>
  new Promise<void>((r) => setTimeout(r, LOCKFILE_RETRY_DELAY_MS));

async function readEntriesWithRetry(
  lockfilePath: string,
  localLockfilePath: string | undefined,
  waitBeforeRetry: () => Promise<void>,
): Promise<InstalledEntries> {
  try {
    return await readInstalledEntries(lockfilePath, localLockfilePath);
  } catch (error) {
    // The managed lockfile is a datastore cache file that a sync pull can
    // rewrite non-atomically; one short retry rides that out.
    if (!(error instanceof SyntaxError)) throw error;
    await waitBeforeRetry();
    return await readInstalledEntries(lockfilePath, localLockfilePath);
  }
}

/**
 * Wires real infrastructure into ExtensionListDeps.
 *
 * @param lockfilePath The resolved extension lockfile: the managed config
 *   base's under managedConfig, `<modelsDir>/upstream_extensions.json`
 *   otherwise (swamp-club#2508).
 * @param localLockfilePath The transitional in-repo auto-resolve lockfile,
 *   whose entries are listed too (the resolved entry wins on a clash),
 *   except one gone from disk that awaits reinstall.
 */
export async function createExtensionListDeps(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath?: string,
  options?: {
    /** Test seam: waits before re-reading a lockfile that failed to parse. */
    waitBeforeRetry?: () => Promise<void>;
  },
): Promise<ExtensionListDeps> {
  const { entries, localOnly } = await readEntriesWithRetry(
    lockfilePath,
    localLockfilePath,
    options?.waitBeforeRetry ?? waitBeforeRetryDefault,
  );
  // An auto-resolved extension gone from disk is not installed: the
  // auto-resolver reinstalls it the next time one of its types is needed.
  const listed = { ...entries };
  for (const name of localOnly) {
    if (await isAbsentFromDisk(repoDir, name, entries[name])) {
      delete listed[name];
    }
  }
  const pulledRoot = resolvePulledExtensionsRoot(repoDir);
  return {
    lockfileRepository: new LockfileRepository(lockfilePath, listed),
    readOnDiskVersion: (name) =>
      readManifestIdentityAt(join(pulledRoot, name, "manifest.yaml"))
        ?.version ?? null,
    autoResolvedNames: localOnly,
    removeToReinstall: (name) =>
      pathsToRemoveForReinstall(repoDir, name, entries),
  };
}

/** Yields the list of installed upstream extensions. */
export async function* extensionList(
  _ctx: LibSwampContext,
  deps: ExtensionListDeps,
): AsyncIterable<ExtensionListEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.list",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const upstreamData = deps.lockfileRepository.getAllEntries();

      const entries: ExtensionListEntry[] = Object.entries(upstreamData)
        .map(([name, entry]) => {
          // Entries without a pinned version have nothing to compare.
          const onDisk = !entry.version || isVersionConstraint(entry.version)
            ? null
            : deps.readOnDiskVersion?.(name) ?? null;
          return {
            name,
            version: entry.version,
            pulledAt: entry.pulledAt ?? "",
            files: entry.files ?? [],
            ...(entry.channel ? { channel: entry.channel } : {}),
            ...(onDisk && onDisk !== entry.version
              ? { onDiskVersion: onDisk }
              : {}),
            ...(deps.autoResolvedNames?.has(name)
              ? {
                autoResolved: true as const,
                ...(deps.removeToReinstall
                  ? { removeToReinstall: deps.removeToReinstall(name) }
                  : {}),
              }
              : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      yield { kind: "completed", data: { extensions: entries } };
    })(),
  );
}
