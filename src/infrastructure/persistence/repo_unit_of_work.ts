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
 * Units of work bound to a repository context: datastore rework Phase 2
 * (swamp-club#3025, swamp-club#3032).
 *
 * A repository stages into the ambient unit of work only when the unit wraps
 * that repository's exact mark hook (`signalChange` in
 * `unit_of_work_scope.ts`). Every repository a repository context builds
 * shares one hook, `repoContext.markDirty`, so the CLI and serve open units
 * through {@link repoUnitOfWorkFactory} and {@link runInRootUnitOfWork},
 * which pass that instance itself. Never wrap or rebuild the hook: a unit
 * over any other function collects nothing, though marks still reach the
 * sync service.
 *
 * **Root and child units.** A command or request runs in one root unit
 * ({@link runInRootUnitOfWork}) that pushes once when it ends, on every
 * outcome. A unit opened while a unit for the same hook is ambient is that
 * unit's child: it forwards each change as before, rolls it up into the
 * root, and never pushes. A root can also push partway through with
 * `checkpoint()` (swamp-club#3053), which stays off the domain
 * {@link UnitOfWork} port.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../logging/logger.ts";
import {
  createLegacyUnitOfWork,
  legacyParentFor,
  legacyUnitOfWorkSettled,
} from "./legacy_unit_of_work.ts";
import type { RepositoryContext } from "./repository_factory.ts";
import { currentUnitOfWork, runInUnitOfWork } from "./unit_of_work_scope.ts";

/**
 * The v3 commit log a repository context commits through (swamp-club#3279),
 * when its datastore is v3. The v3 opt-in builds it over the context's own
 * hook; this module only calls it, so the persistence layer never imports
 * the v3 engine. Absent on every v2 context, which keeps today's legacy
 * units unchanged.
 */
export interface CommitLogEngine {
  /** Opens a use case's commit-log unit: a child of the open unit for this context, or a root. */
  openUnit(): UnitOfWork;
  /** Whether a commit-log unit for this context is open around the call. */
  hasOpenUnit(): boolean;
  /**
   * Commits, mid-operation, what the open unit around the call and its
   * ancestors have staged so far, keeping them open (swamp-club#3587).
   */
  checkpointOpenUnit(): Promise<OpenUnitCheckpoint>;
  /**
   * Runs `fn` in a commit-log root for this context and ends it as
   * `options.disposition` decides; see `runInCommitLogRoot`.
   */
  runRoot<T>(
    options: CommitLogRootRunOptions<T>,
    fn: (root: CommitLogRootView) => Promise<T>,
  ): Promise<T>;
}

/**
 * What {@link CommitLogEngine.checkpointOpenUnit} did: committed, found no
 * open unit (or one whose root has ended) and committed nothing, or met a
 * refused partition, which the root settles when it ends.
 */
export type OpenUnitCheckpoint = "committed" | "no-unit" | "refused";

/** What a commit-log root gives the code it runs. */
export interface CommitLogRootView
  extends Pick<UnitOfWork, "stage" | "staged"> {
  /** Commits what was staged so far and keeps the root open. */
  checkpoint(): Promise<void>;
}

/** How the operation a commit-log root ran ended. */
export type CommitLogRunOutcome<T> =
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false; readonly error: unknown };

/** Options for {@link CommitLogEngine.runRoot}. */
export interface CommitLogRootRunOptions<T> {
  /**
   * Whether the root commits or discards, from how `fn` ended. By default
   * it commits when `fn` resolved and discards when it threw.
   */
  disposition?: (outcome: CommitLogRunOutcome<T>) => "commit" | "discard";
  /**
   * Settles a refused partition by failing the workflow-run steps that name
   * refused data, before the root commits (`reconcileRefusedRuns`). Set on
   * the root of every operation that runs a workflow or a model method.
   */
  reconcileRuns?: boolean;
}

/**
 * The commit-log engine of each v3 context, by the context's hook. Hook
 * identity already decides which unit a write stages into; it decides which
 * engine a root or unit opens through too, so code that holds only the hook
 * (`{ markDirty }`) opens v3 roots on a v3 context.
 */
const engines = new WeakMap<MarkDirtyHook, CommitLogEngine>();

/**
 * Records that the context whose hook is `markDirty` commits through
 * `engine` (swamp-club#3279). `createRepositoryContext` calls it when it
 * builds a v3 context; a hook is bound to one engine for good.
 */
export function bindCommitLogEngine(
  markDirty: MarkDirtyHook,
  engine: CommitLogEngine,
): void {
  if (engines.has(markDirty)) {
    throw new Error("a repository context's hook already has a commit log");
  }
  engines.set(markDirty, engine);
}

/** The commit-log engine of the v3 context `repoContext` names, if any. */
function commitLogOf(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): CommitLogEngine | undefined {
  return repoContext.commitLog ??
    (repoContext.markDirty === undefined
      ? undefined
      : engines.get(repoContext.markDirty));
}

/** What production chose for a unit the test seam builds. */
export interface BoundUnitOfWorkOptions {
  /** The push the unit runs when it ends; undefined for every child. */
  flush: (() => Promise<void>) | undefined;
  /**
   * The ambient unit for the same hook, which the new unit rolls up into;
   * undefined for a root.
   */
  parent: UnitOfWork | undefined;
  /**
   * `"root"` for the unit {@link runInRootUnitOfWork} opens, `"use-case"`
   * for one a use case opens through {@link openRepoUnitOfWork}.
   */
  role: "root" | "use-case";
}

/** Builds the unit of work for one operation over the given mark hook. */
export type BoundUnitOfWorkFactory = (
  markDirty: MarkDirtyHook | undefined,
  options: BoundUnitOfWorkOptions,
) => UnitOfWork;

let factoryForTesting: BoundUnitOfWorkFactory | undefined;

/** A root {@link runInRootUnitOfWork} opened, with the hook it is bound to. */
interface AmbientRoot {
  markDirty: MarkDirtyHook | undefined;
  root: RootUnitOfWork;
}

/**
 * The roots open around the current call, innermost last. A list, not one
 * entry, so a root for one hook opened inside a root for another leaves the
 * outer one findable. Async context rather than a map keyed by hook: serve
 * runs concurrent requests over one shared hook.
 */
const ambientRoots = new AsyncLocalStorage<readonly AmbientRoot[]>();

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * The open unit a new unit over `markDirty` rolls up into: the ambient unit,
 * or its nearest open ancestor when it has already ended.
 */
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
 * Opens a use case's unit of work over `markDirty`, as production does. Inside
 * a unit for the same hook it is a child; otherwise a root. It has no flush
 * either way, so ending it pushes nothing and the existing flush paths keep
 * pushing. A change staged after it ended goes to an open ancestor, or to the
 * hook, instead of failing the command.
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

/**
 * The unit-of-work factory for a `LibSwampContext` whose use cases write
 * through `repoContext`'s repositories. Each unit wraps
 * `repoContext.markDirty` itself. With no hook (filesystem datastores,
 * read-only contexts) the unit is unbound and stages nothing.
 */
export function repoUnitOfWorkFactory(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): () => UnitOfWork {
  const commitLog = commitLogOf(repoContext);
  if (commitLog !== undefined) return () => commitLog.openUnit();
  return () => openRepoUnitOfWork(repoContext.markDirty);
}

/**
 * What composition code gets of its root: it stages hand marks, can read
 * what was staged, and can push partway through, but never ends the root;
 * {@link runInRootUnitOfWork} does.
 */
export interface RootUnitOfWork extends Pick<UnitOfWork, "stage" | "staged"> {
  /**
   * A mid-operation push (swamp-club#3053), not the catalog's WAL
   * checkpoint (`CatalogStore.checkpoint`). Waits for every mark the root
   * and its children sent before the call, as ending the root does, then
   * awaits the `checkpoint` option the root was opened with. The root stays
   * open and still runs its flush once when it ends. The wait covers legacy
   * units only: a unit a test factory builds any other way
   * (`useUnitOfWorkFactoryForTesting`) is not waited on.
   *
   * Throws when the root was opened without a `checkpoint` option, when the
   * call that opened it became a child of an outer root (the outer root owns
   * the checkpoint), and after the root has ended. A failing checkpoint
   * push rejects here, inside `fn`, as a direct push would.
   *
   * It lives here and on the legacy adapter, not on the domain
   * {@link UnitOfWork} port: what a Phase 3 commit-log unit means by a
   * partial commit is a Phase 3 decision.
   *
   * `signal` is passed to the checkpoint option, so a caller that bounds
   * the push can abort it. Resolves with what the option resolved with: the
   * count of files pushed, when its push path reports one (the managed
   * lockfile publish checks it, swamp-club#3192).
   */
  checkpoint(options?: CheckpointOptions): Promise<number | void>;
}

/** Options for {@link RootUnitOfWork.checkpoint}. */
export interface CheckpointOptions {
  /** Aborts the checkpoint's push. */
  signal?: AbortSignal;
}

/** How the operation a root ran ended, as its flush sees it. */
export interface RootFlushOutcome {
  /** `fn` resolved; false when it threw. */
  completed: boolean;
}

/** Options for {@link runInRootUnitOfWork}. */
export interface RootUnitOfWorkOptions {
  /**
   * The push the root runs once when it ends, given how `fn` ended. It runs
   * on every outcome unless `pushWhen` says otherwise.
   */
  flush: ((outcome: RootFlushOutcome) => Promise<void>) | undefined;
  /**
   * When the flush runs: `"always"` (the default) on every outcome, or
   * `"completed"` only when `fn` resolved, for an operation that pushed
   * only on success. A flush whose push depends on more than the outcome
   * reads `outcome.completed` itself instead.
   */
  pushWhen?: "always" | "completed";
  /**
   * The mid-operation push `root.checkpoint()` runs; absent when the
   * operation never pushes partway through. It receives the caller's
   * options, and what it resolves with is what `checkpoint()` resolves with.
   * See {@link RootUnitOfWork.checkpoint}.
   */
  checkpoint?: (options: CheckpointOptions) => Promise<number | void>;
  /**
   * Receives the push error when `fn` threw and the push failed too; `fn`'s
   * error is the one rethrown. Without it the push error is logged at warn.
   */
  onFlushError?: (error: unknown) => void;
  /**
   * How the root ends on a v3 context, which commits rather than pushes
   * (swamp-club#3279). Ignored on v2. The flush still runs after the root
   * ends, since it also releases the command's locks.
   */
  commitLog?: CommitLogRootRunOptions<unknown>;
}

/**
 * Runs one command or request in a root unit of work over
 * `repoContext.markDirty`, and pushes once when it ends.
 *
 * - `fn` runs with the root ambient, so every use case it runs opens a child
 *   that rolls up into the root. It receives the root so composition code
 *   stages the changes it makes outside repositories through it: a bare mark
 *   becomes `root.stage({ kind: "bulk", reason: "<command>" })`, and a
 *   per-path mark `root.stage({ kind: "write" | "remove", path })`. The
 *   legacy root forwards each as the identical hook call. `fn` never ends
 *   the root: it is typed {@link RootUnitOfWork}, without `commit` or
 *   `abandon`.
 * - The root always ends: `commit` when `fn` resolved, `abandon` when it
 *   threw. A legacy root flushes either way, as today's paths push on every
 *   outcome, unless `pushWhen: "completed"` skips the flush when `fn` threw.
 *   The flush receives the outcome either way.
 * - When `fn` threw and the flush also throws, `fn`'s error is rethrown and
 *   the flush error goes to `onFlushError` (or a warn log). When `fn`
 *   resolved and the flush throws, the flush error is thrown.
 * - Called while an open unit for the same hook is ambient (or an ended one
 *   with an open ancestor), it opens a child of that open unit, which never
 *   pushes; the outer root pushes. Such a nested call must pass
 *   `flush: undefined`: one given a push throws, rather than drop that push
 *   silently. With no open unit for the hook it is a root and flushes.
 * - The same holds for `checkpoint`: a nested call given one throws, and
 *   `checkpoint()` on a nested call's child throws, so the outer root owns
 *   every mid-operation push.
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

/**
 * {@link runInRootUnitOfWork} on a v3 context: the same contract, with a
 * commit-log root in place of the legacy one (swamp-club#3279). The root
 * commits instead of pushing; the flush still runs once after it ends, as
 * it releases the locks the command took, and a nested call or checkpoint
 * is refused exactly as on v2.
 */
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
    // The root commits when the v2 root would push: on every outcome, or
    // only when `fn` resolved under `pushWhen: "completed"` (swamp-club#3279).
    // So a failed operation's records reach the commit log as v2 publishes
    // them. Refused partitions are settled for every root: only a root
    // holding a run record has anything to reconcile.
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

/**
 * Commits, mid-operation, what the units open around the call over this
 * context have staged so far (swamp-club#3587): `no-unit` on a v2 context,
 * which commits nothing, and outside every unit.
 */
export async function checkpointOpenUnitOfWork(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
): Promise<OpenUnitCheckpoint> {
  return await commitLogOf(repoContext)?.checkpointOpenUnit() ?? "no-unit";
}

/**
 * The root unit of work {@link runInRootUnitOfWork} opened around the
 * current call over this exact `markDirty` hook, or undefined when there is
 * none. Hook identity decides, as it decides where `signalChange` stages: a
 * root over any other function, a wrapper of this one included, is not
 * returned. Inside a nested call that became a child, it returns the outer
 * root, which owns the checkpoint. After that root has ended it still
 * returns it, and its `checkpoint()` throws.
 *
 * For code that must publish through the root of the operation it runs in
 * without being handed it: the managed extension lockfile publish stages the
 * lockfile and pushes at this root's checkpoint (swamp-club#3192), so its
 * sync port, and every fake of that port, stays unchanged.
 */
export function currentRootUnitOfWork(
  markDirty: MarkDirtyHook,
): RootUnitOfWork | undefined {
  const roots = ambientRoots.getStore() ?? [];
  return roots.findLast((ambient) => ambient.markDirty === markDirty)?.root;
}

/**
 * Test seam: makes {@link openRepoUnitOfWork} and {@link runInRootUnitOfWork}
 * build units with `factory` until the returned function is called.
 * `factory` receives the exact hook, flush and parent production would use,
 * so the seam can observe units and choose their late-stage policy but
 * cannot change what they bind to. Throws when a factory is already
 * installed. Only tests may call it
 * (`integration/datastore_write_seams_rules_test.ts`).
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
