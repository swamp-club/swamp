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

/**
 * a repository stages into the ambient unit only when it wraps that
 * repository's exact markDirty hook; never wrap or rebuild the hook, or the
 * unit collects nothing
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import type { PutExpect } from "../../domain/datastore_v3/op.ts";
import type {
  DirectAppendOptions,
  TypedChange,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ConfigEditConflictError } from "../../domain/datastore_v3/config_edit_conflict.ts";
import {
  type DefinitionKind,
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  createLegacyUnitOfWork,
  legacyParentFor,
  legacyUnitOfWorkSettled,
} from "./legacy_unit_of_work.ts";
import type { RepositoryContext } from "./repository_factory.ts";
import { currentUnitOfWork, runInUnitOfWork } from "./unit_of_work_scope.ts";

/**
 * this module only calls the v3 engine, so persistence never imports it; absent
 * on v2 contexts, which keep legacy units
 */
export interface CommitLogEngine {
  openUnit(): UnitOfWork;
  hasOpenUnit(): boolean;
  checkpointOpenUnit(
    options?: { readonly release?: string },
  ): Promise<OpenUnitCheckpoint>;
  /** epoch ms of the caller's open unit's last commit of what it had staged */
  lastCheckpointAt?(): number | undefined;
  /**
   * this process is serve on this datastore: members may lease its behaviors
   * whether or not serve claimed it, so serve's own reads lock too
   */
  heldByServe?(): boolean;
  /**
   * once every run record naming the refused data of these partitions is
   * saved again without it, so the root's end neither holds nor throws it
   */
  acknowledgeOpenUnitRefusals?(partitions: readonly PartitionKey[]): void;
  /**
   * commits the changes at once as their own commit, leaving what the open
   * unit has staged; throws when the commit fails or is refused
   */
  appendToOpenUnit?(
    changes: readonly TypedChange[],
    options?: DirectAppendOptions,
  ): Promise<OpenUnitAppend>;
  committedBeforeThrowing(error: unknown): boolean;
  runRoot<T>(
    options: CommitLogRootRunOptions<T>,
    fn: (root: CommitLogRootView) => Promise<T>,
  ): Promise<T>;
  storedVersion?(partition: PartitionKey, key: string): Promise<PutExpect>;
  /** true when commits go to serve, which decides each on its sender's grants */
  readonly forwardsToServe?: boolean;
  configLoaded?(partition: PartitionKey): void;
  staleConfigEdits?(partition: PartitionKey): Promise<StaleConfigRecord[]>;
  /** this command caught up from serve, and serve was reachable then */
  reachedServe?(): boolean;
}

export interface StaleConfigRecord {
  readonly key: string;
  readonly changedBy?: string;
  readonly changedAt?: string;
}

export type OpenUnitCheckpoint = "committed" | "no-unit" | "refused";

/** excluded: the configured directories leave the key out of the datastore */
export type OpenUnitAppend =
  | "committed"
  | "queued"
  | "excluded"
  | "no-unit"
  | "unsupported";

export interface CommitLogRootView
  extends Pick<UnitOfWork, "stage" | "staged"> {
  checkpoint(): Promise<void>;
}

export type CommitLogRunOutcome<T> =
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false; readonly error: unknown };

export interface CommitLogRootRunOptions<T> {
  disposition?: (outcome: CommitLogRunOutcome<T>) => "commit" | "discard";
  reconcileRuns?: boolean;
  onEnded?: (committed: boolean) => void;
  /** a lease the root's final commits end, once they all land */
  releaseWithEnd?: string;
}

/**
 * hook identity decides which engine a root or unit opens through, so code
 * holding only the hook opens v3 roots on a v3 context
 */
const engines = new WeakMap<MarkDirtyHook, CommitLogEngine>();

export function bindCommitLogEngine(
  markDirty: MarkDirtyHook,
  engine: CommitLogEngine,
): void {
  if (engines.has(markDirty)) {
    throw new Error("a repository context's hook already has a commit log");
  }
  engines.set(markDirty, engine);
}

function commitLogOf(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): CommitLogEngine | undefined {
  return repoContext.commitLog ??
    (repoContext.markDirty === undefined
      ? undefined
      : engines.get(repoContext.markDirty));
}

export interface BoundUnitOfWorkOptions {
  flush: (() => Promise<void>) | undefined;
  parent: UnitOfWork | undefined;
  role: "root" | "use-case";
}

export type BoundUnitOfWorkFactory = (
  markDirty: MarkDirtyHook | undefined,
  options: BoundUnitOfWorkOptions,
) => UnitOfWork;

let factoryForTesting: BoundUnitOfWorkFactory | undefined;

interface AmbientRoot {
  markDirty: MarkDirtyHook | undefined;
  root: RootUnitOfWork;
}

/**
 * a list so a root for one hook inside a root for another leaves the outer
 * findable; async context, not a hook-keyed map, because serve runs concurrent
 * requests over one hook
 */
const ambientRoots = new AsyncLocalStorage<readonly AmbientRoot[]>();

const logger = getSwampLogger(["datastore", "unit-of-work"]);

function ambientFor(
  markDirty: MarkDirtyHook | undefined,
): UnitOfWork | undefined {
  return legacyParentFor(markDirty, currentUnitOfWork());
}

function openUnit(
  markDirty: MarkDirtyHook | undefined,
  options: BoundUnitOfWorkOptions,
): UnitOfWork {
  if (factoryForTesting !== undefined) {
    return factoryForTesting(markDirty, options);
  }
  return createLegacyUnitOfWork(markDirty, {
    flush: options.flush,
    afterCommit: "forward",
    parent: options.parent,
  });
}

/**
 * no flush, so ending it pushes nothing and existing flush paths keep pushing;
 * a late-staged change goes to an open ancestor or the hook instead of failing
 * the command
 */
export function openRepoUnitOfWork(
  markDirty: MarkDirtyHook | undefined,
): UnitOfWork {
  const engine = markDirty === undefined ? undefined : engines.get(markDirty);
  if (engine !== undefined) return engine.openUnit();
  return openUnit(markDirty, {
    flush: undefined,
    parent: ambientFor(markDirty),
    role: "use-case",
  });
}

export function repoUnitOfWorkFactory(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): () => UnitOfWork {
  const commitLog = commitLogOf(repoContext);
  if (commitLog !== undefined) return () => commitLog.openUnit();
  return () => openRepoUnitOfWork(repoContext.markDirty);
}

export interface RootUnitOfWork extends Pick<UnitOfWork, "stage" | "staged"> {
  /**
   * not the catalog WAL checkpoint; waits for marks sent so far, then runs the
   * checkpoint option. Throws without that option, on a child of an outer root,
   * or after the root ended
   */
  checkpoint(options?: CheckpointOptions): Promise<number | void>;
}

export interface CheckpointOptions {
  signal?: AbortSignal;
}

export interface RootFlushOutcome {
  completed: boolean;
}

export interface RootUnitOfWorkOptions {
  flush: ((outcome: RootFlushOutcome) => Promise<void>) | undefined;
  pushWhen?: "always" | "completed";
  checkpoint?: (options: CheckpointOptions) => Promise<number | void>;
  onFlushError?: (error: unknown) => void;
  commitLog?: CommitLogRootRunOptions<unknown>;
}

/**
 * a nested call becomes a child that never pushes and must pass flush:
 * undefined; one given a flush or checkpoint throws rather than drop it
 * silently
 */
export async function runInRootUnitOfWork<T>(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  options: RootUnitOfWorkOptions,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const commitLog = commitLogOf(repoContext);
  if (commitLog !== undefined) {
    return await runInCommitLogEngineRoot(
      repoContext.markDirty,
      commitLog,
      options,
      fn,
    );
  }
  const markDirty = repoContext.markDirty;
  const parent = ambientFor(markDirty);
  if (parent !== undefined && options.flush !== undefined) {
    throw new Error(
      "a root unit of work was opened inside another for the same hook with " +
        "its own push; give that push to the outer root, or run it outside",
    );
  }
  if (parent !== undefined && options.checkpoint !== undefined) {
    throw new Error(
      "a root unit of work was opened inside another for the same hook with " +
        "its own checkpoint; give that checkpoint to the outer root",
    );
  }
  const flush = options.flush;
  const pushWhen = options.pushWhen ?? "always";
  let completed = false;
  const root = openUnit(markDirty, {
    flush: flush === undefined ? undefined : async () => {
      if (pushWhen === "completed" && !completed) return;
      await flush({ completed });
    },
    parent,
    role: "root",
  });
  let ended = false;
  const view: RootUnitOfWork = {
    stage: (change) => root.stage(change),
    staged: () => root.staged(),
    async checkpoint(checkpointOptions: CheckpointOptions = {}) {
      if (ended) {
        throw new Error("checkpoint called after its root unit of work ended");
      }
      if (parent !== undefined) {
        throw new Error(
          "checkpoint called on a nested root unit of work, which is a child " +
            "of the outer root; the outer root owns the checkpoint",
        );
      }
      if (options.checkpoint === undefined) {
        throw new Error(
          "checkpoint called on a root unit of work opened without a " +
            "checkpoint option",
        );
      }
      await legacyUnitOfWorkSettled(root);
      return await options.checkpoint(checkpointOptions);
    },
  };
  // Only a root itself is findable through currentRootUnitOfWork; a nested
  // call is a child, and its view's checkpoint throws.
  const run = parent === undefined
    ? () =>
      ambientRoots.run(
        [...(ambientRoots.getStore() ?? []), { markDirty, root: view }],
        () => fn(view),
      )
    : () => fn(view);
  let value: T;
  try {
    value = await runInUnitOfWork(root, run);
  } catch (error) {
    ended = true;
    try {
      await root.abandon();
    } catch (flushError) {
      if (options.onFlushError !== undefined) {
        options.onFlushError(flushError);
      } else {
        logger
          .warn`Push after a failed operation also failed: ${flushError}`;
      }
    }
    throw error;
  }
  ended = true;
  completed = true;
  await root.commit();
  return value;
}

async function runInCommitLogEngineRoot<T>(
  markDirty: MarkDirtyHook | undefined,
  engine: CommitLogEngine,
  options: RootUnitOfWorkOptions,
  fn: (root: RootUnitOfWork) => Promise<T>,
): Promise<T> {
  const nested = engine.hasOpenUnit();
  if (nested && options.flush !== undefined) {
    throw new Error(
      "a root unit of work was opened inside another for the same hook with " +
        "its own push; give that push to the outer root, or run it outside",
    );
  }
  if (nested && options.checkpoint !== undefined) {
    throw new Error(
      "a root unit of work was opened inside another for the same hook with " +
        "its own checkpoint; give that checkpoint to the outer root",
    );
  }
  const pushWhen = options.pushWhen ?? "always";
  let ended = false;
  let value: T;
  try {
    // commit on every outcome, or only when fn resolved under pushWhen
    // completed, so a failed operation's records reach the commit log as v2
    // publishes them
    const rootOptions: CommitLogRootRunOptions<T> = {
      disposition: (outcome) =>
        outcome.completed || pushWhen === "always" ? "commit" : "discard",
      reconcileRuns: true,
      ...(options.commitLog as CommitLogRootRunOptions<T> | undefined),
    };
    value = await engine.runRoot(
      rootOptions,
      (root) => {
        const view: RootUnitOfWork = {
          stage: (change) => root.stage(change),
          staged: () => root.staged(),
          async checkpoint(checkpointOptions: CheckpointOptions = {}) {
            if (ended) {
              throw new Error(
                "checkpoint called after its root unit of work ended",
              );
            }
            if (nested) {
              throw new Error(
                "checkpoint called on a nested root unit of work, which is a " +
                  "child of the outer root; the outer root owns the checkpoint",
              );
            }
            if (options.checkpoint === undefined) {
              throw new Error(
                "checkpoint called on a root unit of work opened without a " +
                  "checkpoint option",
              );
            }
            await root.checkpoint();
            return await options.checkpoint(checkpointOptions);
          },
        };
        return nested ? fn(view) : ambientRoots.run(
          [...(ambientRoots.getStore() ?? []), { markDirty, root: view }],
          () => fn(view),
        );
      },
    );
  } catch (error) {
    ended = true;
    if (options.flush !== undefined && pushWhen === "always") {
      try {
        await options.flush({ completed: false });
      } catch (flushError) {
        if (options.onFlushError !== undefined) {
          options.onFlushError(flushError);
        } else {
          logger.warn`Push after a failed operation also failed: ${flushError}`;
        }
      }
    }
    throw error;
  }
  ended = true;
  if (options.flush !== undefined) await options.flush({ completed: true });
  return value;
}

export function commitsThroughCommitLog(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): boolean {
  return commitLogOf(repoContext) !== undefined;
}

export async function appendToOpenUnitOfWork(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  changes: readonly TypedChange[],
  options?: DirectAppendOptions,
): Promise<OpenUnitAppend> {
  const engine = commitLogOf(repoContext);
  if (engine?.appendToOpenUnit === undefined) return "no-unit";
  return await engine.appendToOpenUnit(changes, options);
}

export function forwardsToServe(markDirty: MarkDirtyHook | undefined): boolean {
  return markDirty !== undefined &&
    engines.get(markDirty)?.forwardsToServe === true;
}

export async function storedVersionOf(
  markDirty: MarkDirtyHook | undefined,
  partition: PartitionKey,
  key: string,
): Promise<PutExpect | undefined> {
  if (markDirty === undefined) return undefined;
  return await engines.get(markDirty)?.storedVersion?.(partition, key);
}

export function lastOpenUnitCheckpointAt(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): number | undefined {
  return commitLogOf(repoContext)?.lastCheckpointAt?.();
}

export function servesV3Datastore(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): boolean {
  return commitLogOf(repoContext)?.heldByServe?.() === true;
}

export function acknowledgeOpenUnitRefusals(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  partitions: readonly PartitionKey[],
): void {
  commitLogOf(repoContext)?.acknowledgeOpenUnitRefusals?.(partitions);
}

export async function checkpointOpenUnitOfWork(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  options?: { readonly release?: string },
): Promise<OpenUnitCheckpoint> {
  return await commitLogOf(repoContext)?.checkpointOpenUnit(options) ??
    "no-unit";
}

/**
 * a failure is only a warning: the load itself succeeded, and a later edit is
 * at worst refused
 */
export function markConfigLoaded(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  kind: DefinitionKind,
  name: string,
): void {
  const commitLog = commitLogOf(repoContext);
  if (commitLog?.configLoaded === undefined) return;
  try {
    commitLog.configLoaded(
      partitionOf({ kind: "config", definitionKind: kind, name }),
    );
  } catch (error) {
    logger.warn`Noting that ${kind} ${name} was loaded failed: ${error}`;
  }
}

/**
 * refuses before anything changes: a use case writing other partitions first
 * commits them on its own, so a refusal at the definition's commit would come
 * too late
 */
export async function assertConfigEditCurrent(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  kind: DefinitionKind,
  name: string,
): Promise<void> {
  const stale = await commitLogOf(repoContext)?.staleConfigEdits?.(
    partitionOf({ kind: "config", definitionKind: kind, name }),
  );
  if (stale === undefined || stale.length === 0) return;
  throw new ConfigEditConflictError(
    stale.map((record) => ({
      kind,
      name,
      key: record.key,
      ...(record.changedBy === undefined
        ? {}
        : { changedBy: record.changedBy }),
      ...(record.changedAt === undefined
        ? {}
        : { changedAt: record.changedAt }),
    })),
    undefined,
  );
}

/**
 * content prepared before the command (stdin) may be stale and is refused; an
 * editor opens on the checkout's current file, so opening it counts as a load
 */
export async function startConfigEdit(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  kind: DefinitionKind,
  name: string,
  inEditor: boolean,
  options: { readonly mayRename?: boolean } = {},
): Promise<void> {
  if (inEditor) {
    markConfigLoaded(repoContext, kind, name);
    return;
  }
  // serve decides the grant before the base, so a caller without the grant is
  // never shown who changed it; a rename commits its new name first, so it,
  // and anything offline, is still refused here
  const commitLog = commitLogOf(repoContext);
  if (
    options.mayRename === false && commitLog?.forwardsToServe === true &&
    commitLog.reachedServe?.() === true
  ) {
    return;
  }
  await assertConfigEditCurrent(repoContext, kind, name);
}

export function rootCommittedBeforeThrowing(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  error: unknown,
): boolean {
  return commitLogOf(repoContext)?.committedBeforeThrowing(error) ?? false;
}

/**
 * hook identity decides: a root over any other function, a wrapper included, is
 * not returned; inside a nested child call it returns the outer root, and its
 * checkpoint() throws once it has ended
 */
export function currentRootUnitOfWork(
  markDirty: MarkDirtyHook,
): RootUnitOfWork | undefined {
  const roots = ambientRoots.getStore() ?? [];
  return roots.findLast((ambient) => ambient.markDirty === markDirty)?.root;
}

/**
 * test-only: the factory sees the exact hook, flush and parent production would
 * use, so it can observe units but not change what they bind to; throws if one
 * is already installed
 */
export function useUnitOfWorkFactoryForTesting(
  factory: BoundUnitOfWorkFactory,
): () => void {
  if (factoryForTesting !== undefined) {
    throw new Error("a unit-of-work test factory is already installed");
  }
  factoryForTesting = factory;
  return () => {
    if (factoryForTesting === factory) factoryForTesting = undefined;
  };
}
