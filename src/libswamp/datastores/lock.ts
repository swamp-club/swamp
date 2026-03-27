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

import type {
  DistributedLock,
  LockInfo,
} from "../../domain/datastore/distributed_lock.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { walk } from "@std/fs";
import { relative } from "@std/path";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type { LockInfo } from "../../domain/datastore/distributed_lock.ts";

// ── Lock status ────────────────────────────────────────────────────────

/** Output data for a single lock status check. */
export interface DatastoreLockStatusData {
  held: boolean;
  info?: LockInfo;
  datastoreType: string;
  /** If set, identifies this as a per-model lock (e.g. "aws-ec2/my-server"). */
  lockScope?: string;
}

export type DatastoreLockStatusEvent =
  | { kind: "completed"; data: DatastoreLockStatusData }
  | { kind: "model_lock"; data: DatastoreLockStatusData }
  | { kind: "error"; error: SwampError };

/** Input for lock status. */
export interface DatastoreLockStatusInput {
  datastoreType: string;
  isFilesystemDatastore: boolean;
}

/** Dependencies for lock status. */
export interface DatastoreLockStatusDeps {
  inspectGlobalLock: () => Promise<LockInfo | null>;
  scanModelLocks: () => Promise<
    Array<{
      lockKey: string;
      modelType: string;
      modelId: string;
      info: LockInfo;
    }>
  >;
}

/** Checks the current datastore lock status. */
export async function* datastoreLockStatus(
  ctx: LibSwampContext,
  deps: DatastoreLockStatusDeps,
  input: DatastoreLockStatusInput,
): AsyncIterable<DatastoreLockStatusEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.lock.status",
    {},
    (async function* () {
      ctx.logger.debug`Checking global lock status`;

      const info = await deps.inspectGlobalLock();

      // Scan for per-model locks (filesystem only) — yield these first
      if (input.isFilesystemDatastore) {
        const modelLocks = await deps.scanModelLocks();
        for (const ml of modelLocks) {
          yield {
            kind: "model_lock",
            data: {
              held: true,
              info: ml.info,
              datastoreType: input.datastoreType,
              lockScope: `${ml.modelType}/${ml.modelId}`,
            },
          };
        }
      }

      // Yield the global status as the final completed event
      yield {
        kind: "completed",
        data: {
          held: info !== null,
          info: info ?? undefined,
          datastoreType: input.datastoreType,
        },
      };
    })(),
  );
}

// ── Lock release ───────────────────────────────────────────────────────

/** Output data for a lock release operation. */
export interface DatastoreLockReleaseData {
  released: boolean;
  reason?: string;
  previousHolder?: LockInfo;
}

export type DatastoreLockReleaseEvent =
  | { kind: "completed"; data: DatastoreLockReleaseData }
  | { kind: "error"; error: SwampError };

/** Input for lock release (reserved for future options). */
export type DatastoreLockReleaseInput = Record<string, never>;

/** Dependencies for lock release. */
export interface DatastoreLockReleaseDeps {
  inspectLock: () => Promise<LockInfo | null>;
  forceRelease: (nonce: string) => Promise<boolean>;
}

/** Force-releases a stuck datastore lock. */
export async function* datastoreLockRelease(
  ctx: LibSwampContext,
  deps: DatastoreLockReleaseDeps,
  _input: DatastoreLockReleaseInput = {},
): AsyncIterable<DatastoreLockReleaseEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.lock.release",
    {},
    (async function* () {
      ctx.logger.debug`Checking lock before force-release`;

      const info = await deps.inspectLock();

      if (!info) {
        yield {
          kind: "completed",
          data: {
            released: false,
            reason: "no lock held",
          },
        };
        return;
      }

      // Re-verify the lock holder hasn't changed between inspect and delete.
      // forceRelease() re-reads the nonce immediately before deleting to
      // minimise the TOCTOU window.
      const released = await deps.forceRelease(info.nonce!);
      if (!released) {
        yield {
          kind: "completed",
          data: {
            released: false,
            reason:
              "lock holder changed — aborting to avoid breaking an active lock",
          },
        };
        return;
      }

      ctx.logger.debug`Lock force-released`;

      yield {
        kind: "completed",
        data: {
          released: true,
          previousHolder: info,
        },
      };
    })(),
  );
}

// ── Factory functions ─────────────────────────────────────────────────

/**
 * Scans the datastore for per-model lock files.
 * Only works for filesystem datastores.
 */
async function scanModelLocks(
  datastorePath: string,
): Promise<
  Array<{
    lockKey: string;
    modelType: string;
    modelId: string;
    info: LockInfo;
  }>
> {
  const results: Array<{
    lockKey: string;
    modelType: string;
    modelId: string;
    info: LockInfo;
  }> = [];

  try {
    for await (
      const entry of walk(datastorePath, {
        includeDirs: false,
        match: [/\.lock$/],
      })
    ) {
      const rel = relative(datastorePath, entry.path);
      // Match pattern: data/{modelType}/{modelId}/.lock
      const parts = rel.split("/");
      if (
        parts.length === 4 && parts[0] === "data" && parts[3] === ".lock"
      ) {
        try {
          const content = await Deno.readTextFile(entry.path);
          const info = JSON.parse(content) as LockInfo;
          results.push({
            lockKey: rel,
            modelType: parts[1],
            modelId: parts[2],
            info,
          });
        } catch {
          // Skip unreadable lock files
        }
      }
    }
  } catch {
    // Datastore directory may not exist
  }

  return results;
}

/** Wires real infrastructure into DatastoreLockStatusDeps. */
export function createDatastoreLockStatusDeps(
  globalLock: DistributedLock,
  config: DatastoreConfig,
): DatastoreLockStatusDeps {
  const isFilesystem = !isCustomDatastoreConfig(config) &&
    config.type === "filesystem";
  const datastorePath = isFilesystem ? (config as { path: string }).path : "";

  return {
    inspectGlobalLock: () => globalLock.inspect(),
    scanModelLocks: () => scanModelLocks(datastorePath),
  };
}

/** Wires real infrastructure into DatastoreLockReleaseDeps. */
export function createDatastoreLockReleaseDeps(
  lock: DistributedLock,
): DatastoreLockReleaseDeps {
  return {
    inspectLock: () => lock.inspect(),
    forceRelease: (nonce: string) => lock.forceRelease(nonce),
  };
}
