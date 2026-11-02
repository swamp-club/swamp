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
import { ModelType } from "../../domain/models/model_type.ts";
import { walk } from "@std/fs";
import { relative, SEPARATOR } from "@std/path";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export type { LockInfo } from "../../domain/datastore/distributed_lock.ts";

/**
 * uses / rather than SEPARATOR because lock keys are opaque strings to custom
 * providers, such as S3 object keys
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
 * sits outside data/ and workflow-runs/ so neither the per-model lock scan nor
 * the run repository sees it, and is named .lock, the one name datastore sync
 * never transfers
 */
export function workflowRunLockKey(
  namespace: string | undefined,
  runId: string,
): string {
  const base = `workflow-run-claims/${runId}/.lock`;
  return namespace ? `${namespace}/${base}` : base;
}

/** uses SEPARATOR because the path comes from relative() in @std/path */
export function stripNamespacePrefix(
  namespace: string | undefined,
  rel: string,
): string {
  if (!namespace) return rel;
  const prefix = `${namespace}${SEPARATOR}`;
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

/**
 * modelType may contain / for scoped extension types; splits on the platform
 * separator since relative() returns native paths, and modelType is always
 * /-joined
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
 * right-anchored, because modelType may itself contain /: the last / separates
 * modelType from modelId
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

/** a spec whose type names another type never acts on the behavior found */
export function modelSpecTypeMatches(
  specType: string,
  foundType: string,
): boolean {
  try {
    return ModelType.create(specType).normalized === foundType;
  } catch {
    return false;
  }
}

export interface DatastoreLockStatusData {
  held: boolean;
  info?: LockInfo;
  datastoreType: string;
  lockScope?: string;
}

/** who holds the lease is reported only as caller or other, never who */
export interface ServeLeaseStatusData {
  lockKey: string;
  heldBy: "caller" | "other";
  expiresAt: string;
}

export type DatastoreLockStatusEvent =
  | { kind: "completed"; data: DatastoreLockStatusData }
  | { kind: "model_lock"; data: DatastoreLockStatusData }
  | { kind: "serve_lease"; data: ServeLeaseStatusData }
  | {
    kind: "serve_leases_truncated";
    data: { truncated: true; listed: number };
  }
  | { kind: "error"; error: SwampError };

export interface DatastoreLockStatusInput {
  datastoreType: string;
  isFilesystemDatastore: boolean;
}

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
  listServeLeases?: () => Promise<
    | { leases: readonly ServeLeaseStatusData[]; truncated: boolean }
    | undefined
  >;
  /** serve is the only source of the answer, so a failed listing fails */
  serveLeasesRequired?: boolean;
}

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

      // Then the leases serve holds, for a checkout written through serve.
      // A serve that cannot answer never hides the local locks: this is the
      // command to run when things are stuck.
      let served: Awaited<
        ReturnType<NonNullable<DatastoreLockStatusDeps["listServeLeases"]>>
      >;
      try {
        served = await deps.listServeLeases?.();
      } catch (error) {
        if (deps.serveLeasesRequired === true) throw error;
        ctx.logger
          .warn`Could not list the leases serve holds: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      for (const lease of served?.leases ?? []) {
        yield {
          kind: "serve_lease",
          data: {
            lockKey: lease.lockKey,
            heldBy: lease.heldBy,
            expiresAt: lease.expiresAt,
          },
        };
      }
      if (served?.truncated === true) {
        yield {
          kind: "serve_leases_truncated",
          data: { truncated: true, listed: served.leases.length },
        };
      }

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

export interface DatastoreLockReleaseData {
  released: boolean;
  reason?: string;
  previousHolder?: LockInfo;
  leaseHolder?: string;
}

export type DatastoreLockReleaseEvent =
  | { kind: "completed"; data: DatastoreLockReleaseData }
  | { kind: "error"; error: SwampError };

export type DatastoreLockReleaseInput = Record<string, never>;

export interface DatastoreLockReleaseDeps {
  inspectLock: () => Promise<LockInfo | null>;
  forceRelease: (nonce: string) => Promise<boolean>;
  releaseServeLease?: () => Promise<
    { readonly released: boolean; readonly heldBy?: string }
  >;
}

export async function* datastoreLockRelease(
  ctx: LibSwampContext,
  deps: DatastoreLockReleaseDeps,
  _input: DatastoreLockReleaseInput = {},
): AsyncIterable<DatastoreLockReleaseEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.lock.release",
    {},
    (async function* () {
      if (deps.releaseServeLease !== undefined) {
        ctx.logger.debug`Asking serve to end the lease on the behavior`;
        const outcome = await deps.releaseServeLease();
        yield {
          kind: "completed",
          data: outcome.released
            ? {
              released: true,
              ...(outcome.heldBy !== undefined
                ? { leaseHolder: outcome.heldBy }
                : {}),
            }
            : { released: false, reason: "serve holds no lease on it" },
        };
        return;
      }

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

      // a lock its holder is still writing has no nonce to fence on, and
      // forceRelease would report it as a changed holder
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

const CUSTOM_MODEL_LOCK_INSPECT_CONCURRENCY = 16;

/**
 * only models this checkout lists are inspected, so a lock is missed for a
 * model it does not know yet: not pulled here, another clone's auto-definition,
 * or deleted here
 */
export interface CustomModelLockSource {
  listModels: () => Promise<Array<{ modelType: string; modelId: string }>>;
  createLock: (lockKey: string) => DistributedLock;
}

/**
 * a failed inspect fails the scan: reporting the model as unlocked would be
 * wrong for a lock that could not be read
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

/**
 * a checkout written through serve binds no storage: it has no datastore-wide
 * lock, and its behaviors' locks are serve's leases
 */
export function createServeMemberLockStatusDeps(
  listServeLeases: NonNullable<DatastoreLockStatusDeps["listServeLeases"]>,
): DatastoreLockStatusDeps {
  return {
    inspectGlobalLock: () => Promise.resolve(null),
    scanModelLocks: () => Promise.resolve([]),
    listServeLeases,
    serveLeasesRequired: true,
  };
}

/** never touches serve's writer lease or the caller's own leases */
export function createServeMemberLockReleaseDeps(): DatastoreLockReleaseDeps {
  return {
    inspectLock: () => Promise.resolve(null),
    forceRelease: () => Promise.resolve(false),
  };
}

export function createServeLeaseReleaseDeps(
  release: () => Promise<
    { readonly released: boolean; readonly heldBy?: string }
  >,
): DatastoreLockReleaseDeps {
  return {
    inspectLock: () => Promise.resolve(null),
    forceRelease: () => Promise.resolve(false),
    releaseServeLease: release,
  };
}

export function createDatastoreLockReleaseDeps(
  lock: Pick<DistributedLock, "inspect" | "forceRelease">,
): DatastoreLockReleaseDeps {
  return {
    inspectLock: () => lock.inspect(),
    forceRelease: (nonce: string) => lock.forceRelease(nonce),
  };
}
