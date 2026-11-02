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
  unitAdmissions,
  unitOfWorkBinding,
  unitWrites,
  versionFloors,
  type VersionFloorSource,
} from "./unit_of_work_binding.ts";

const ambientUnitOfWork = new AsyncLocalStorage<UnitOfWork>();

/**
 * kept apart from the ambient unit so a unit that takes no typed changes,
 * opened inside it, does not hide it; always empty on v2
 */
const ambientTypedUnit = new AsyncLocalStorage<UnitOfWork>();

const logger = getSwampLogger(["datastore", "unit-of-work"]);

export function runInUnitOfWork<T>(
  uow: UnitOfWork,
  fn: () => Promise<T>,
): Promise<T> {
  if (typedStagers.stagerOf(uow) !== undefined) {
    return ambientTypedUnit.run(uow, () => ambientUnitOfWork.run(uow, fn));
  }
  return ambientUnitOfWork.run(uow, fn);
}

export function currentUnitOfWork(): UnitOfWork | undefined {
  return ambientUnitOfWork.getStore();
}

/**
 * routes to the ambient unit bound to the hook, else the hook itself (refused
 * with UnscopedWriteRefusedError on a v3 hook), else nowhere; call it before
 * the write
 */
export async function signalChange(
  markDirty: MarkDirtyHook | undefined,
  change: StagedChange,
  options: { readonly typed?: boolean } = {},
): Promise<void> {
  if (markDirty === undefined) {
    // inside a v3 unit a hookless typed write stages through stageTyped and any
    // other is offered to the unit, which refuses a path-only change rather
    // than drop it
    const adopter = adoptingUnit();
    if (adopter !== undefined) unitWrites.signal(adopter);
    if (adopter !== undefined && !options.typed) await adopter.stage(change);
    return;
  }
  const uow = currentUnitOfWork();
  const requiresUnit = unitOfWorkBinding.requiresUnit(markDirty);
  if (
    uow !== undefined && unitOfWorkBinding.boundHook(uow) === markDirty &&
    // a legacy unit forwards to the hook, so it cannot serve a hook that
    // requires a unit, even one built before the hook was marked
    !(requiresUnit && legacyUnitOfWorkTarget(uow) !== undefined)
  ) {
    unitWrites.signal(uow);
    if (options.typed && typedStagers.stagerOf(uow) !== undefined) return;
    await uow.stage(change);
    return;
  }
  if (requiresUnit) {
    // an unbound unit a use case opened does not hide the v3 unit around it
    // that is bound to this hook
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
 * the signal after closes the window where a push mid-write cleared the mark;
 * sent even if write throws, only for hooks needing no unit, and the write's
 * own error wins
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
      for (const change of list) {
        try {
          await signalChange(markDirty, change, options);
        } catch {
          // The write's own failure is the one the caller needs to see.
        }
      }
    }
    throw error;
  }
  if (signalAfter) {
    for (const change of list) {
      try {
        await signalChange(markDirty, change, options);
      } catch (error) {
        // the write has landed, so a failed signal after must not report it
        // failed; a push during the write may have cleared the mark and the
        // next push can miss the path, so warn
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
 * call once per batch, since a batch lands in one commit; with no bound unit on
 * a v3 context it throws UnscopedWriteRefusedError rather than drop the write
 */
export async function stageTyped(
  markDirty: MarkDirtyHook | undefined,
  build: () => readonly TypedChange[] | Promise<readonly TypedChange[]>,
): Promise<void> {
  if (markDirty === undefined) {
    const adopter = adoptingUnit();
    const stage = adoptingStager();
    if (adopter === undefined || stage === undefined) return;
    // the files are written by now: the unit learns of them before the build
    // can throw
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
 * a repository asks before a write whose typed change needs something the write
 * destroys, such as the digest of the file it replaces; false on v2, so v2
 * reads nothing extra
 */
export function typedStagingActive(
  markDirty: MarkDirtyHook | undefined,
): boolean {
  if (markDirty === undefined) return adoptingStager() !== undefined;
  return unitOfWorkBinding.requiresUnit(markDirty) &&
    boundTypedStager(markDirty) !== undefined;
}

/**
 * false with no such unit, so a caller that did not first ask
 * typedStagingActive makes its write durable rather than skip it
 */
export function unitAdmitsKey(
  markDirty: MarkDirtyHook | undefined,
  key: string,
): boolean {
  const uow = markDirty === undefined
    ? adoptingStager() === undefined ? undefined : adoptingUnit()
    : boundTypedStager(markDirty)?.unit;
  if (uow === undefined) return false;
  return unitAdmissions.of(uow)?.(key) ?? true;
}

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

export function takesTypedChanges(uow: UnitOfWork): boolean {
  return typedStagers.stagerOf(uow) !== undefined;
}

function adoptingStager() {
  const uow = adoptingUnit();
  return uow === undefined ? undefined : typedStagers.stagerOf(uow);
}

/**
 * none when every unit has ended: a callback that outlived its operation then
 * marks nothing, as on v2
 */
function adoptingUnit(): UnitOfWork | undefined {
  const uow = ambientTypedUnit.getStore();
  return uow === undefined ? undefined : typedStagers.openTargetOf(uow);
}

function boundTypedStager(markDirty: MarkDirtyHook) {
  const uow = currentUnitOfWork();
  if (uow !== undefined && unitOfWorkBinding.boundHook(uow) === markDirty) {
    const stage = typedStagers.stagerOf(uow);
    return stage === undefined ? undefined : { unit: uow, stage };
  }
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
 * a v3 datastore has no route 2: a write it was not told about through a unit
 * would never be committed. Nothing was marked or written.
 */
export class UnscopedWriteRefusedError extends Error {
  constructor(
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

export interface UnscopedCaller {
  readonly file: string;
  readonly line: number;
  readonly fn: string | undefined;
}

export interface UnscopedChange {
  readonly change: StagedChange;
  readonly caller: UnscopedCaller | undefined;
}

/**
 * Receives each route-2 write. An error it throws rejects `signalChange`
 * after the mark was sent.
 */
export type UnscopedChangeReporter = (report: UnscopedChange) => void;

let reporterForTesting: UnscopedChangeReporter | undefined;
const warnedCallSites = new Set<string>();

const SOURCE_ROOT = new URL("../../../", import.meta.url).href;
const PERSISTENCE_DIR = "src/infrastructure/persistence/";
// Diagnostic phases wrap a repository's work without being its caller.
const DIAGNOSTICS_DIR = "src/domain/diagnostics/";
const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(\S+?):(\d+):\d+\)?$/;

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
    !frame.file.startsWith(PERSISTENCE_DIR) &&
    !frame.file.startsWith(DIAGNOSTICS_DIR)
  );
  if (index === -1) return foreign;
  const frame = frames[index];
  const fn = frame.fn ??
    frames.slice(index + 1).find((below) =>
      below.file === frame.file && below.fn !== undefined
    )?.fn;
  return { file: frame.file, line: frame.line, fn };
}

function functionName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.replace(/ \[as [^\]]+\]$/, "").replace(/^Object\./, "");
  return name === "" || name === "<anonymous>" ? undefined : name;
}

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

export function resetUnscopedWarningsForTesting(): void {
  warnedCallSites.clear();
}

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
