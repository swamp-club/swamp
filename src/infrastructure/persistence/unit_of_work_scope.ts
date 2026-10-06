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
 * the ambient unit of work only when that unit was created by
 * `createLegacyUnitOfWork` over the repository's own hook instance. Otherwise
 * it calls its hook as today, so its changes still reach its own datastore.
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
import { legacyUnitOfWorkTarget } from "./legacy_unit_of_work.ts";

const ambientUnitOfWork = new AsyncLocalStorage<UnitOfWork>();

const logger = getSwampLogger(["datastore", "unit-of-work"]);

/**
 * Runs `fn` with `uow` as the ambient unit of work. Scopes nest: the
 * innermost unit is active inside, and the outer one is active again after.
 */
export function runInUnitOfWork<T>(
  uow: UnitOfWork,
  fn: () => Promise<T>,
): Promise<T> {
  return ambientUnitOfWork.run(uow, fn);
}

/** The ambient unit of work, or undefined outside every scope. */
export function currentUnitOfWork(): UnitOfWork | undefined {
  return ambientUnitOfWork.getStore();
}

/**
 * Sends a repository's change signal to the right place, in order:
 *
 * 1. the ambient unit of work, when it is bound to `markDirty` (it then
 *    forwards the change to that same hook);
 * 2. otherwise `markDirty` itself: the path for `write` and `remove`, nothing
 *    for `bulk`;
 * 3. otherwise nowhere (filesystem datastores have no hook).
 *
 * Call it before the write, as `notifyDirty` always has. A rejected hook
 * rejects the returned promise with the same error on either route.
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
): Promise<void> {
  if (markDirty === undefined) return;
  const uow = currentUnitOfWork();
  if (uow !== undefined && legacyUnitOfWorkTarget(uow) === markDirty) {
    await uow.stage(change);
    return;
  }
  await markDirty(change.kind === "bulk" ? undefined : change.path);
  reportUnscopedChange(change);
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

function reportUnscopedChange(change: StagedChange): void {
  // Ten frames (V8's default) can end inside the persistence layer.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const report: UnscopedChange = {
    change,
    caller: unscopedCallerFrom(stack, SOURCE_ROOT),
  };
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
