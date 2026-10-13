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

import type {
  DistributedLock,
  LockInfo,
} from "../../domain/datastore/distributed_lock.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { walk } from "@std/fs";
import { relative, SEPARATOR } from "@std/path";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type { LockInfo } from "../../domain/datastore/distributed_lock.ts";

// ── Lock-key construction ─────────────────────────────────────────────

/**
 * Constructs the canonical per-model lock key, optionally scoped under a
 * namespace. Uses `/` (not SEPARATOR) since lock keys are passed as opaque
 * strings to custom providers (e.g. S3 object keys).
 */
export function modelLockKey(
  namespace: string | undefined,
  modelType: string,
  modelId: string,
): string {
  const base = `data/${modelType}/${modelId}/.lock`;
  return namespace ? `${namespace}/${base}` : base;
}

/**
 * Constructs the lock key of a workflow run's claim, optionally scoped under
 * a namespace. It sits outside `data/` and `workflow-runs/`, so neither the
 * per-model lock scan nor the run repository's directory reads see it, and
 * the file is named `.lock`, the one name datastore sync never transfers.
 */
export function workflowRunLockKey(
  namespace: string | undefined,
  runId: string,
): string {
  const base = `workflow-run-claims/${runId}/.lock`;
  return namespace ? `${namespace}/${base}` : base;
}

/**
 * Strips a leading `{namespace}{SEPARATOR}` from a filesystem-relative path
 * so that `parseModelLockKey` can parse it. Uses SEPARATOR because this
 * operates on paths produced by `relative()` from `@std/path`.
 * Returns the input unchanged when namespace is empty or the prefix doesn't
 * match.
 */
export function stripNamespacePrefix(
  namespace: string | undefined,
  rel: string,
): string {
  if (!namespace) return rel;
  const prefix = `${namespace}${SEPARATOR}`;
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

// ── Lock-key parsing ───────────────────────────────────────────────────

/**
 * Parses a per-model lock key (relative path under the datastore root) into
 * its modelType and modelId components.
 *
 * Lock keys have the form `data/<modelType>/<modelId>/.lock`, where
 * `<modelType>` may itself contain `/` for scoped extension types
 * (e.g. `@hivemq/harvester-host-kernel`). Returns null for keys that do
 * not match this shape.
 *
 * Splits on the platform path separator since `relative()` from
 * `@std/path` returns native-separated paths. The returned `modelType`
 * is always `/`-joined (the canonical key form), regardless of the
 * platform the path came from.
 */
export function parseModelLockKey(
  rel: string,
): { modelType: string; modelId: string } | null {
  const parts = rel.split(SEPARATOR);
  if (
    parts.length < 4 ||
    parts[0] !== "data" ||
    parts[parts.length - 1] !== ".lock"
  ) {
    return null;
  }
  const modelId = parts[parts.length - 2];
  const modelType = parts.slice(1, parts.length - 2).join("/");
  if (!modelType || !modelId) return null;
  return { modelType, modelId };
}

/**
 * Parses a `<modelType>/<modelId>` CLI argument (e.g. the `--model` flag
 * to `swamp datastore lock release`).
 *
 * The modelType may itself contain `/` for scoped extension types, so
 * parsing is right-anchored: the last `/` separates modelType from
 * modelId, everything before is modelType. Returns null for inputs with
 * no separator, an empty modelType, or an empty modelId.
 */
export function parseModelSpec(
  spec: string,
): { modelType: string; modelId: string } | null {
  const lastSlash = spec.lastIndexOf("/");
  if (lastSlash <= 0 || lastSlash === spec.length - 1) return null;
  return {
    modelType: spec.slice(0, lastSlash),
    modelId: spec.slice(lastSlash + 1),
  };
}

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
  /**
   * Kept for callers; per-model locks are reported for every datastore type
   * since swamp-club#3372.
   */
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

      // Per-model locks are yielded first
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

      // A lock its holder is still writing has no nonce to fence on, and
      // forceRelease would report it as a changed holder (swamp-club#3152).
      if (info.holderUnknown) {
        yield {
          kind: "completed",
          data: {
            released: false,
            reason: "lock is being written by its holder — retry shortly",
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
  namespace?: string,
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
      const parsed = parseModelLockKey(stripNamespacePrefix(namespace, rel));
      if (!parsed) continue;
      try {
        const content = await Deno.readTextFile(entry.path);
        const info = JSON.parse(content) as LockInfo;
        results.push({
          lockKey: modelLockKey(namespace, parsed.modelType, parsed.modelId),
          modelType: parsed.modelType,
          modelId: parsed.modelId,
          info,
        });
      } catch {
        // Skip unreadable lock files
      }
    }
  } catch {
    // Datastore directory may not exist
  }

  return results;
}

/** At most this many per-model lock inspects run at once on a custom datastore. */
const CUSTOM_MODEL_LOCK_INSPECT_CONCURRENCY = 16;

/**
 * Where a custom datastore's per-model locks come from. A bucket has no
 * directory to walk, so each of the repo's models has its lock built the way
 * a run builds it and inspected.
 *
 * Only models this checkout lists are inspected, so a lock is missed for a
 * model this checkout does not know yet: a git-tracked definition not pulled
 * here, another clone's auto-definition before this clone's next sync, or a
 * model deleted here.
 */
export interface CustomModelLockSource {
  /** The repo's models, as the modelType/modelId pairs runs lock on. */
  listModels: () => Promise<Array<{ modelType: string; modelId: string }>>;
  /** Builds the datastore's lock for a per-model lock key. */
  createLock: (lockKey: string) => DistributedLock;
}

/**
 * Inspects each listed model's lock through the custom datastore's own lock,
 * with bounded concurrency. A failed inspect fails the scan: reporting the
 * model as unlocked would be the wrong answer for a lock that could not be
 * read.
 */
async function scanCustomModelLocks(
  source: CustomModelLockSource,
  namespace?: string,
): Promise<
  Array<{
    lockKey: string;
    modelType: string;
    modelId: string;
    info: LockInfo;
  }>
> {
  const byKey = new Map<string, { modelType: string; modelId: string }>();
  for (const model of await source.listModels()) {
    const key = modelLockKey(namespace, model.modelType, model.modelId);
    if (!byKey.has(key)) byKey.set(key, model);
  }
  const pending = [...byKey.entries()];

  const results: Array<{
    lockKey: string;
    modelType: string;
    modelId: string;
    info: LockInfo;
  }> = [];
  const worker = async () => {
    for (let next = pending.shift(); next; next = pending.shift()) {
      const [lockKey, { modelType, modelId }] = next;
      try {
        const info = await source.createLock(lockKey).inspect();
        if (info) results.push({ lockKey, modelType, modelId, info });
      } catch (error) {
        // Stop the other workers taking more models; the scan has failed.
        pending.length = 0;
        throw new Error(
          `Could not inspect the lock for ${modelType}/${modelId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  };
  // allSettled so no inspect is still in flight when the scan returns.
  const settled = await Promise.allSettled(
    Array.from(
      {
        length: Math.min(CUSTOM_MODEL_LOCK_INSPECT_CONCURRENCY, pending.length),
      },
      worker,
    ),
  );
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;

  const scope = (r: { modelType: string; modelId: string }) =>
    `${r.modelType}/${r.modelId}`;
  return results.sort((a, b) => scope(a) < scope(b) ? -1 : 1);
}

/**
 * Wires real infrastructure into DatastoreLockStatusDeps.
 *
 * A custom datastore reports per-model locks only when `customModelLocks`
 * is given.
 */
export function createDatastoreLockStatusDeps(
  globalLock: Pick<DistributedLock, "inspect">,
  config: DatastoreConfig,
  customModelLocks?: CustomModelLockSource,
): DatastoreLockStatusDeps {
  if (isCustomDatastoreConfig(config)) {
    return {
      inspectGlobalLock: () => globalLock.inspect(),
      scanModelLocks: () =>
        customModelLocks
          ? scanCustomModelLocks(customModelLocks, config.namespace)
          : Promise.resolve([]),
    };
  }

  return {
    inspectGlobalLock: () => globalLock.inspect(),
    scanModelLocks: () => scanModelLocks(config.path, config.namespace),
  };
}

/** Wires real infrastructure into DatastoreLockReleaseDeps. */
export function createDatastoreLockReleaseDeps(
  lock: Pick<DistributedLock, "inspect" | "forceRelease">,
): DatastoreLockReleaseDeps {
  return {
    inspectLock: () => lock.inspect(),
    forceRelease: (nonce: string) => lock.forceRelease(nonce),
  };
}
