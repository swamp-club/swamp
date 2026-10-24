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
 * The ambient unit of work: datastore rework Phase 1 (swamp-club#2971).
 *
 * A use case runs its operation inside {@link runInUnitOfWork}, and the
 * repositories it calls stage their changes into that unit of work instead of
 * calling their mark hook. Outside a scope, repositories call their hook
 * directly, as they always have. Two production functions open a scope
 * (pinned by `integration/datastore_write_seams_rules_test.ts`):
 * `withUnitOfWork` (`src/libswamp/unit_of_work.ts`) around each write use
 * case, and `runInRootUnitOfWork` (`repo_unit_of_work.ts`) around a whole
 * command or request. The units they open forward each change to the same
 * hook, so the routing below changes nothing a user can see.
 *
 * **One repository context per unit.** Two repository contexts can share a
 * process (side-by-side repos, namespace migration). A repository stages into
 * the ambient unit of work only when that unit is bound to the repository's
 * own hook instance in the binding registry (`unit_of_work_binding.ts`,
 * swamp-club#3240): `createLegacyUnitOfWork` binds each unit it builds over
 * a hook, and the v3 commit-log adapter binds its own. Otherwise it calls
 * its hook as today, so its changes still reach its own datastore, unless
 * the hook belongs to a v3 datastore, which refuses the write instead.
 *
 * **Scope follows the async call chain.** The scope is an `AsyncLocalStorage`
 * store: concurrent operations (serve handlers, `Promise.all`) each see their
 * own unit of work. A promise started inside a scope keeps that scope even
 * when it is awaited after the scope returns. If its unit has ended
 * (committed or abandoned) by then, the late `stage` goes to the unit's
 * nearest open ancestor, when it is a child; otherwise it follows the unit's
 * `afterCommit` policy: units built for tests reject it with "unit of work
 * already committed" (or "abandoned"), and production units
 * (`repo_unit_of_work.ts`) send it straight to the hook. End a unit only
 * after every write started in its scope has settled.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { getSwampLogger } from "../logging/logger.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { legacyUnitOfWorkTarget } from "./legacy_unit_of_work.ts";
import {
  typedStagers,
  unitOfWorkBinding,
  unitWrites,
  versionFloors,
  type VersionFloorSource,
} from "./unit_of_work_binding.ts";

const ambientUnitOfWork = new AsyncLocalStorage<UnitOfWork>();

/**
 * The innermost unit that takes typed changes (a v3 commit-log unit) around
 * the call, kept apart from {@link ambientUnitOfWork} so a unit that takes
 * none (a use case's unbound unit) opened inside it does not hide it. A
 * repository with no hook stages into it (swamp-club#3279). On v2 no such
 * unit exists, so this is always empty there.
 */
const ambientTypedUnit = new AsyncLocalStorage<UnitOfWork>();

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * Runs `fn` with `uow` as the ambient unit of work. Scopes nest: the
 * innermost unit is active inside, and the outer one is active again after.
 */
export function runInUnitOfWork<T>(
  uow: UnitOfWork,
  fn: () => Promise<T>,
): Promise<T> {
  if (typedStagers.stagerOf(uow) !== undefined) {
    return ambientTypedUnit.run(uow, () => ambientUnitOfWork.run(uow, fn));
  }
  return ambientUnitOfWork.run(uow, fn);
}

/** The ambient unit of work, or undefined outside every scope. */
export function currentUnitOfWork(): UnitOfWork | undefined {
  return ambientUnitOfWork.getStore();
}

/**
 * Sends a repository's change signal to the right place, in order:
 *
 * 1. the ambient unit of work, when it is bound to `markDirty` (a legacy unit
 *    then forwards the change to that same hook);
 * 2. otherwise `markDirty` itself: the path for `write` and `remove`, nothing
 *    for `bulk`. A hook marked with `requireUnit` (a v3 datastore's) has no
 *    route 2: the write is refused with {@link UnscopedWriteRefusedError}
 *    before anything is marked (decision 3 of "v3 domain model",
 *    `design/enablers/datastores.md`);
 * 3. otherwise nowhere (filesystem datastores have no hook).
 *
 * Call it before the write, as `notifyDirty` always has; a repository wraps
 * the write in {@link withChangeSignalled}, which calls it again once the
 * write has landed on v2 (swamp-club#2421). A rejected hook rejects the
 * returned promise with the same error on either route.
 *
 * With `options.typed`, the repository declares that it stages typed changes
 * for this write through {@link stageTyped} once the write is done
 * (swamp-club#3250). In a unit that takes typed changes (a v3 commit-log
 * unit) the path change is then checked, not staged: the unit takes no
 * path-only change. Everywhere else the option changes nothing.
 *
 * Route 2 is the fallback for a hooked write made outside every unit bound
 * to its hook. It marks exactly as it always has, then reports the write
 * (swamp-club#3056): production logs a warning once per call site, and tests
 * fail through {@link useUnscopedChangeReporterForTesting}. A later Phase 2
 * step removes route 2 once nothing reports; see
 * `design/enablers/datastores.md`.
 */
export async function signalChange(
  markDirty: MarkDirtyHook | undefined,
  change: StagedChange,
  options: { readonly typed?: boolean } = {},
): Promise<void> {
  if (markDirty === undefined) {
    // A repository built without a hook marks nothing on v2. Inside a v3
    // commit-log unit its write belongs to that unit (swamp-club#3279): a
    // typed write stages through stageTyped, and any other is offered to
    // the unit, which refuses a path-only change rather than drop it.
    const adopter = adoptingUnit();
    if (adopter !== undefined) unitWrites.signal(adopter);
    if (adopter !== undefined && !options.typed) await adopter.stage(change);
    return;
  }
  const uow = currentUnitOfWork();
  const requiresUnit = unitOfWorkBinding.requiresUnit(markDirty);
  if (
    uow !== undefined && unitOfWorkBinding.boundHook(uow) === markDirty &&
    // A legacy unit forwards to the hook, so it cannot serve a hook that
    // requires a unit, even one built before the hook was marked.
    !(requiresUnit && legacyUnitOfWorkTarget(uow) !== undefined)
  ) {
    unitWrites.signal(uow);
    if (options.typed && typedStagers.stagerOf(uow) !== undefined) return;
    await uow.stage(change);
    return;
  }
  if (requiresUnit) {
    // An unbound unit a use case opened (no repository context) does not
    // hide the v3 unit around it that is bound to this hook
    // (swamp-club#3279).
    const outer = adoptingUnit();
    if (
      outer !== undefined && unitOfWorkBinding.boundHook(outer) === markDirty
    ) {
      unitWrites.signal(outer);
      if (options.typed && typedStagers.stagerOf(outer) !== undefined) return;
      await outer.stage(change);
      return;
    }
    throw new UnscopedWriteRefusedError(change, callerOfThisWrite());
  }
  await markDirty(change.kind === "bulk" ? undefined : change.path);
  reportUnscopedChange(change);
}

/**
 * Signals `changes` through {@link signalChange}, in order, before `write`
 * runs and, on v2, again once it has settled (swamp-club#2421). Every
 * repository write and remove goes through it.
 *
 * - The signals before keep what they always gave: a v3 unit checks (or
 *   refuses) each change before anything is written, and a process that
 *   dies mid-write leaves the path marked.
 * - The signals after close the window between the two: a push that ran
 *   while the write was in flight may have uploaded the old bytes (or
 *   re-uploaded a file about to be removed) and cleared the mark. Marking
 *   again once the path holds its final state makes the next push see it.
 *   They are sent when `write` throws too, since a write can land partly
 *   before it fails.
 *
 * The signals after are sent only for a hook that does not require a unit
 * (every v2 context). A v3 hook buffers changes in its commit-log unit,
 * where the signals before already did all there is to do; a hookless
 * repository marks nothing on v2. Marks are idempotent, so a doubled mark
 * changes nothing else.
 *
 * When `write` throws and a signal after fails as well, the write's error
 * is the one rethrown. When `write` succeeds and a signal after fails, the
 * failure is logged as a warning and the result returned, since the write
 * is on disk. The signal before still marked the path, but a push that ran
 * during the write may have cleared that mark, so the next push can then
 * miss the path, which is what the warning says.
 */
export async function withChangeSignalled<T>(
  markDirty: MarkDirtyHook | undefined,
  changes: StagedChange | readonly StagedChange[],
  options: { readonly typed?: boolean },
  write: () => Promise<T>,
): Promise<T> {
  const list: readonly StagedChange[] = isChangeList(changes)
    ? changes
    : [changes];
  for (const change of list) await signalChange(markDirty, change, options);
  const signalAfter = markDirty !== undefined &&
    !unitOfWorkBinding.requiresUnit(markDirty);
  let result: T;
  try {
    result = await write();
  } catch (error) {
    if (signalAfter) {
      try {
        for (const change of list) {
          await signalChange(markDirty, change, options);
        }
      } catch {
        // The write's own failure is the one the caller needs to see.
      }
    }
    throw error;
  }
  if (signalAfter) {
    for (const change of list) {
      try {
        await signalChange(markDirty, change, options);
      } catch (error) {
        // The write has landed, so a failed signal after must not report it
        // as failed. The signal before may already have been cleared by a
        // push that ran during the write, so the next push can miss the
        // path: say so.
        logger
          .warn`Could not mark ${
          changeLabel(change)
        } dirty again after its write landed, so the next datastore push may miss it: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }
  return result;
}

function changeLabel(change: StagedChange): string {
  return change.kind === "bulk" ? "the datastore cache" : change.path;
}

function isChangeList(
  changes: StagedChange | readonly StagedChange[],
): changes is readonly StagedChange[] {
  return Array.isArray(changes);
}

/**
 * Stages the typed changes a repository write made, after the write
 * (swamp-club#3250): the version, the content and whether the latest marker
 * moved are known only then. Call it once per batch: a batch always lands in
 * one commit, and a partition's changes split between batches past
 * `MAX_COMMIT_OPS`.
 *
 * - With no hook, or a hook that does not require a unit (every v2 context),
 *   it returns at once and `build` never runs, so v2 pays nothing.
 * - In a unit bound to the hook that takes typed changes, it runs `build` and
 *   stages what it returns as one batch.
 * - Otherwise the hook belongs to a v3 context with no bound unit ambient,
 *   and the write would never be committed: it throws
 *   {@link UnscopedWriteRefusedError} rather than drop it.
 */
export async function stageTyped(
  markDirty: MarkDirtyHook | undefined,
  build: () => readonly TypedChange[] | Promise<readonly TypedChange[]>,
): Promise<void> {
  if (markDirty === undefined) {
    // See signalChange: a hookless write stages into the ambient v3 unit.
    const adopter = adoptingUnit();
    const stage = adoptingStager();
    if (adopter === undefined || stage === undefined) return;
    // The files are written by now: the unit learns of them before the
    // build can throw (swamp-club#3553).
    unitWrites.signal(adopter);
    const changes = await build();
    if (changes.length > 0) await stage(changes);
    return;
  }
  if (!unitOfWorkBinding.requiresUnit(markDirty)) return;
  const bound = boundTypedStager(markDirty);
  if (bound === undefined) {
    throw new UnscopedWriteRefusedError(undefined, callerOfThisWrite());
  }
  unitWrites.signal(bound.unit);
  const changes = await build();
  if (changes.length > 0) await bound.stage(changes);
}

/**
 * Whether {@link stageTyped} would run its builder now: true only in a unit
 * bound to a hook that requires one and takes typed changes. A repository
 * asks it before a write when a typed change needs something the write
 * destroys, such as the digest of the file it replaces; on v2 it is false,
 * so v2 reads nothing extra.
 */
export function typedStagingActive(
  markDirty: MarkDirtyHook | undefined,
): boolean {
  if (markDirty === undefined) return adoptingStager() !== undefined;
  return unitOfWorkBinding.requiresUnit(markDirty) &&
    boundTypedStager(markDirty) !== undefined;
}

/**
 * The version-floor source of the v3 unit a write through `markDirty` stages
 * into, found as {@link stageTyped} finds its stager; undefined on v2.
 */
export function versionFloorSource(
  markDirty: MarkDirtyHook | undefined,
): VersionFloorSource | undefined {
  if (markDirty === undefined) {
    const uow = adoptingUnit();
    return uow === undefined ? undefined : versionFloors.of(uow);
  }
  if (!unitOfWorkBinding.requiresUnit(markDirty)) return undefined;
  const uow = currentUnitOfWork();
  if (uow !== undefined && unitOfWorkBinding.boundHook(uow) === markDirty) {
    return versionFloors.of(uow);
  }
  const outer = adoptingUnit();
  return outer !== undefined && unitOfWorkBinding.boundHook(outer) === markDirty
    ? versionFloors.of(outer)
    : undefined;
}

/**
 * Whether `uow` takes typed changes: a v3 commit-log unit (swamp-club#3257).
 * `withUnitOfWork` asks it to choose decision 5's ending for a v3 unit; a
 * legacy unit is never one, so v2 endings do not change.
 */
export function takesTypedChanges(uow: UnitOfWork): boolean {
  return typedStagers.stagerOf(uow) !== undefined;
}

/**
 * The typed stager of the innermost v3 unit around the call, which a
 * repository with no hook stages into; undefined on v2.
 */
function adoptingStager() {
  const uow = adoptingUnit();
  return uow === undefined ? undefined : typedStagers.stagerOf(uow);
}

/**
 * The open v3 unit a hookless write in this scope belongs to: the innermost
 * typed unit around the call while it is open, else its nearest open
 * ancestor. None when every one has ended: a callback that outlived its
 * operation then marks nothing, as on v2.
 */
function adoptingUnit(): UnitOfWork | undefined {
  const uow = ambientTypedUnit.getStore();
  return uow === undefined ? undefined : typedStagers.openTargetOf(uow);
}

/**
 * The ambient unit bound to the hook and its typed stager, when it takes
 * typed changes.
 */
function boundTypedStager(markDirty: MarkDirtyHook) {
  const uow = currentUnitOfWork();
  if (uow !== undefined && unitOfWorkBinding.boundHook(uow) === markDirty) {
    const stage = typedStagers.stagerOf(uow);
    return stage === undefined ? undefined : { unit: uow, stage };
  }
  // As in signalChange: an unbound unit does not hide the v3 unit around it.
  const outer = adoptingUnit();
  if (
    outer === undefined || unitOfWorkBinding.boundHook(outer) !== markDirty
  ) {
    return undefined;
  }
  const stage = typedStagers.stagerOf(outer);
  return stage === undefined ? undefined : { unit: outer, stage };
}

/**
 * A hooked write on a v3 datastore made outside every unit of work bound to
 * its repository context (swamp-club#3240). A v3 datastore has no route 2:
 * a write it was not told about through a unit would never be committed.
 * Nothing was marked or written.
 */
export class UnscopedWriteRefusedError extends Error {
  constructor(
    /** The path change; undefined for typed changes ({@link stageTyped}). */
    readonly change: StagedChange | undefined,
    readonly caller: UnscopedCaller | undefined,
  ) {
    const what = change === undefined
      ? "typed change"
      : `${change.kind} of ${
        change.kind === "bulk" ? change.reason : change.path
      }`;
    super(
      `A datastore ${what} from ${
        formatUnscopedCaller(caller)
      } ran outside a unit of work bound to its repository; a v3 datastore ` +
        "commits only through one, so the write was refused",
    );
    this.name = "UnscopedWriteRefusedError";
  }
}

/** Where an unscoped write came from. */
export interface UnscopedCaller {
  /**
   * Path relative to the repository root, e.g. `src/serve/bookkeeping_gc.ts`,
   * or the frame's full URL when it lies outside the repository's source
   * (extension code, an unexpected binary layout).
   */
  readonly file: string;
  readonly line: number;
  /**
   * The frame's function, or the nearest named frame below it in the same
   * file when the frame is an anonymous closure; undefined when neither has
   * a name.
   */
  readonly fn: string | undefined;
}

/** A hooked write that took route 2, reported after its mark was sent. */
export interface UnscopedChange {
  readonly change: StagedChange;
  /**
   * The first frame outside `src/infrastructure/persistence/`; undefined
   * when the stack holds none.
   */
  readonly caller: UnscopedCaller | undefined;
}

/**
 * Receives each route-2 write. An error it throws rejects `signalChange`
 * after the mark was sent.
 */
export type UnscopedChangeReporter = (report: UnscopedChange) => void;

let reporterForTesting: UnscopedChangeReporter | undefined;
const warnedCallSites = new Set<string>();

/**
 * This module's URL less its own path inside the repository: the prefix every
 * frame from the repository's source starts with, under `deno test` and in
 * the compiled binary alike.
 */
const SOURCE_ROOT = new URL("../../../", import.meta.url).href;
const PERSISTENCE_DIR = "src/infrastructure/persistence/";
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(\S+?):(\d+):\d+\)?$/;

/**
 * Finds the caller of a route-2 write in a stack trace: the first frame from
 * the repository's source (`root` is its URL prefix) outside
 * `src/infrastructure/persistence/`. Runtime frames are skipped. With no
 * such frame it falls back to the first `file:` frame outside the
 * repository's source, named by its full URL, so a caller loaded from
 * elsewhere still gets its own warning.
 */
export function unscopedCallerFrom(
  stack: string,
  root: string,
): UnscopedCaller | undefined {
  const frames: { file: string; line: number; fn: string | undefined }[] = [];
  let foreign: UnscopedCaller | undefined;
  for (const text of stack.split("\n")) {
    const match = FRAME.exec(text);
    if (match === null) continue;
    if (!match[2].startsWith(root)) {
      if (
        foreign === undefined && match[2].startsWith("file:") &&
        !match[2].includes(`/${PERSISTENCE_DIR}`)
      ) {
        foreign = {
          file: match[2],
          line: Number(match[3]),
          fn: functionName(match[1]),
        };
      }
      continue;
    }
    frames.push({
      file: match[2].slice(root.length),
      line: Number(match[3]),
      fn: functionName(match[1]),
    });
  }
  const index = frames.findIndex((frame) =>
    !frame.file.startsWith(PERSISTENCE_DIR)
  );
  if (index === -1) return foreign;
  const frame = frames[index];
  const fn = frame.fn ??
    frames.slice(index + 1).find((below) =>
      below.file === frame.file && below.fn !== undefined
    )?.fn;
  return { file: frame.file, line: frame.line, fn };
}

/** `Object.foo [as bar]` → `foo`; `Class.method` is kept whole. */
function functionName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.replace(/ \[as [^\]]+\]$/, "").replace(/^Object\./, "");
  return name === "" || name === "<anonymous>" ? undefined : name;
}

/** The caller of the write `signalChange` is routing. */
function callerOfThisWrite(): UnscopedCaller | undefined {
  // Ten frames (V8's default) can end inside the persistence layer.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  return unscopedCallerFrom(stack, SOURCE_ROOT);
}

function reportUnscopedChange(change: StagedChange): void {
  const report: UnscopedChange = { change, caller: callerOfThisWrite() };
  if (reporterForTesting !== undefined) {
    reporterForTesting(report);
    return;
  }
  try {
    warnOnce(report);
  } catch {
    // The warning is diagnostic only; the mark was already sent.
  }
}

/**
 * A caller as `file:line (fn)`, as the production warning and the test guard
 * both print it.
 */
export function formatUnscopedCaller(
  caller: UnscopedCaller | undefined,
): string {
  if (caller === undefined) return "an unknown caller";
  return `${caller.file}:${caller.line}${
    caller.fn === undefined ? "" : ` (${caller.fn})`
  }`;
}

function warnOnce({ change, caller }: UnscopedChange): void {
  const site = formatUnscopedCaller(caller);
  if (warnedCallSites.has(site)) return;
  warnedCallSites.add(site);
  const target = change.kind === "bulk" ? change.reason : change.path;
  logger
    .warn`A datastore ${change.kind} of ${target} from ${site} ran outside a unit of work; it still syncs (swamp-club#3056)`;
}

/**
 * Test seam: forgets which call sites the production warning has already
 * named, so a test of the warn-once rule sees a first warning on every run
 * (`deno test --repeats`). Only tests may call it
 * (`integration/datastore_write_seams_rules_test.ts`).
 */
export function resetUnscopedWarningsForTesting(): void {
  warnedCallSites.clear();
}

/**
 * Test seam: sends every route-2 write to `reporter` instead of the
 * production warning until the returned function is called. Throws when a
 * reporter is already installed. Only tests may call it
 * (`integration/datastore_write_seams_rules_test.ts`).
 */
export function useUnscopedChangeReporterForTesting(
  reporter: UnscopedChangeReporter,
): () => void {
  if (reporterForTesting !== undefined) {
    throw new Error("an unscoped-change test reporter is already installed");
  }
  reporterForTesting = reporter;
  return () => {
    if (reporterForTesting === reporter) reporterForTesting = undefined;
  };
}
