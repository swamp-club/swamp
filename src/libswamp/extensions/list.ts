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
  findMissingPulledExtensions,
  isAbsentFromDisk,
  type MissingPulledExtensionState,
  pathsToRemoveForReinstall,
  readInstalledEntriesWithRetry,
} from "../../infrastructure/persistence/installed_entries.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { readManifestIdentityAt } from "../../infrastructure/persistence/local_manifest_reader.ts";
import { readPublishedChannel } from "../../infrastructure/persistence/upstream_extensions.ts";
import { isVersionConstraint } from "./pull.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface ExtensionListEntry {
  name: string;
  version: string;
  pulledAt: string;
  files: string[];
  channel?: string;
  /** differs from channel when an exact version was pulled from another channel */
  publishedChannel?: string;
  /**
   * present only when it differs from the lockfile's pinned version: the loaded
   * code is not what the lockfile pins
   */
  onDiskVersion?: string;
  /**
   * present when the entry comes only from the transitional in-repo
   * auto-resolve lockfile, not the team's lockfile
   */
  autoResolved?: true;
  removeToReinstall?: string[];
  /** present when tracked source files are not on disk */
  missing?: MissingPulledExtensionState;
  missingFiles?: string[];
  /** the auto-resolver reinstalls it when one of its types is needed */
  installsOnNextUse?: true;
}

export interface ExtensionListData {
  extensions: ExtensionListEntry[];
}

export type ExtensionListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionListData }
  | { kind: "error"; error: SwampError };

export interface ExtensionListDeps {
  lockfileRepository: LockfileRepository;
  readOnDiskVersion?: (name: string) => string | null;
  autoResolvedNames?: ReadonlySet<string>;
  removeToReinstall?: (name: string) => string[];
  missingOnDisk?: ReadonlyMap<
    string,
    {
      state: MissingPulledExtensionState;
      missingFiles: string[];
      installsOnNextUse: boolean;
    }
  >;
}

/**
 * the resolved entry wins on a clash, and an auto-resolved entry gone from disk
 * that awaits reinstall is not listed
 */
export async function createExtensionListDeps(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath?: string,
  options?: {
    waitBeforeRetry?: () => Promise<void>;
  },
): Promise<ExtensionListDeps> {
  const installed = await readInstalledEntriesWithRetry(
    lockfilePath,
    localLockfilePath,
    options?.waitBeforeRetry,
  );
  const { entries, localOnly } = installed;
  // An auto-resolved extension gone from disk is not installed: the
  // auto-resolver reinstalls it the next time one of its types is needed.
  const listed = { ...entries };
  for (const name of localOnly) {
    if (await isAbsentFromDisk(repoDir, name, entries[name])) {
      delete listed[name];
    }
  }
  const missing = await findMissingPulledExtensions(
    repoDir,
    installed,
    localLockfilePath,
  );
  const pulledRoot = resolvePulledExtensionsRoot(repoDir);
  return {
    lockfileRepository: new LockfileRepository(lockfilePath, listed),
    readOnDiskVersion: (name) =>
      readManifestIdentityAt(join(pulledRoot, name, "manifest.yaml"))
        ?.version ?? null,
    autoResolvedNames: localOnly,
    removeToReinstall: (name) =>
      pathsToRemoveForReinstall(repoDir, name, entries),
    missingOnDisk: new Map(
      missing.map((m) => [m.name, {
        state: m.state,
        missingFiles: m.missingFiles,
        installsOnNextUse: m.installsOnNextUse,
      }]),
    ),
  };
}

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
          const publishedChannel = readPublishedChannel(entry);
          const missing = deps.missingOnDisk?.get(name);
          return {
            name,
            version: entry.version,
            pulledAt: entry.pulledAt ?? "",
            files: entry.files ?? [],
            ...(entry.channel ? { channel: entry.channel } : {}),
            ...(publishedChannel ? { publishedChannel } : {}),
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
            ...(missing
              ? {
                missing: missing.state,
                missingFiles: missing.missingFiles,
                ...(missing.installsOnNextUse
                  ? { installsOnNextUse: true as const }
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
