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

import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
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
}

/** Retry delay for a lockfile caught mid-rewrite. */
const LOCKFILE_RETRY_DELAY_MS = 75;

const waitBeforeRetryDefault = () =>
  new Promise<void>((r) => setTimeout(r, LOCKFILE_RETRY_DELAY_MS));

/**
 * Wires real infrastructure into ExtensionListDeps.
 *
 * @param lockfilePath The resolved extension lockfile: the managed config
 *   base's under managedConfig, `<modelsDir>/upstream_extensions.json`
 *   otherwise (swamp-club#2508).
 */
export async function createExtensionListDeps(
  lockfilePath: string,
  options?: {
    /** Test seam: waits before re-reading a lockfile that failed to parse. */
    waitBeforeRetry?: () => Promise<void>;
  },
): Promise<ExtensionListDeps> {
  try {
    return {
      lockfileRepository: await LockfileRepository.create(lockfilePath),
    };
  } catch (error) {
    // The managed lockfile is a datastore cache file that a sync pull can
    // rewrite non-atomically; one short retry rides that out.
    if (!(error instanceof SyntaxError)) throw error;
    await (options?.waitBeforeRetry ?? waitBeforeRetryDefault)();
    return {
      lockfileRepository: await LockfileRepository.create(lockfilePath),
    };
  }
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
        .map(([name, entry]) => ({
          name,
          version: entry.version,
          pulledAt: entry.pulledAt ?? "",
          files: entry.files ?? [],
          ...(entry.channel ? { channel: entry.channel } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      yield { kind: "completed", data: { extensions: entries } };
    })(),
  );
}
