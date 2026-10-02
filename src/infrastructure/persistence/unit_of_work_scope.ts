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
 * directly, as they always have. In Phase 1 no production code opens a scope
 * (pinned by `integration/datastore_write_seams_rules_test.ts`), so the
 * routing below changes nothing a user can see; Phase 2 opens scopes from use
 * cases.
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
 * when it is awaited after the scope returns. If its unit has been committed
 * by then, the legacy unit rejects the late `stage` with "unit of work already
 * committed", so commit a unit only after every write started in its scope
 * has settled.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { legacyUnitOfWorkTarget } from "./legacy_unit_of_work.ts";

const ambientUnitOfWork = new AsyncLocalStorage<UnitOfWork>();

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
}

/**
 * The {@link StagedChange} for a repository's `notifyDirty(relPath?)` call.
 * Despite its historical name, `relPath` is the absolute path of the file or
 * directory about to change (the composition root's hook makes it
 * cache-relative). A path becomes `write`; no path becomes `bulk` with
 * `reason`.
 *
 * `notifyDirty` cannot tell a write from a remove, so removals are staged as
 * `write` too. The legacy adapter forwards both kinds identically, and a path
 * absent on disk at push time is a delete, so nothing changes. Distinguishing
 * them is the job of the Phase 1 repository moves, which change the call
 * sites themselves. Moved repositories (data and output, swamp-club#2979)
 * stage typed changes directly and no longer call this.
 */
export function changeFor(
  relPath: string | undefined,
  reason: string,
): StagedChange {
  return relPath === undefined
    ? { kind: "bulk", reason }
    : { kind: "write", path: relPath };
}
