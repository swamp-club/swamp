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

import type { MarkDirtyHook } from "./datastore_sync_service.ts";
import { UserError } from "../errors.ts";

/**
 * paths are absolute, as repositories hold them; conversion to cache-relative
 * stays in the composition root's mark hook so the rules live in one place
 */
export type StagedChange =
  | { readonly kind: "write"; readonly path: string }
  | { readonly kind: "remove"; readonly path: string }
  | { readonly kind: "bulk"; readonly reason: string };

/**
 * lives for one operation and ends once through commit or abandon; once spent,
 * staging or ending again is a programming error, and a caller whose commit
 * failed opens a new unit
 */
export interface UnitOfWork {
  /**
   * called before the write begins so a crash mid-write still leaves the change
   * recorded; await each call before its write and the next stage, since order
   * is part of the contract
   */
  stage(change: StagedChange): Promise<void>;
  /**
   * waits for in-flight stage calls; the unit is spent once called, success or
   * not; call after the operation's writes finish, as it does not wait for a
   * write after a resolved stage
   */
  commit(): Promise<void>;
  abandon(): Promise<void>;
  staged(): readonly StagedChange[];
}

/**
 * identity decides: a unit bound to a wrapper of a hook never takes that hook's
 * changes; a v3 context refuses a write outside every bound unit rather than
 * marking it
 */
export interface UnitOfWorkBinding {
  bind(uow: UnitOfWork, markDirty: MarkDirtyHook): void;
  boundHook(uow: UnitOfWork): MarkDirtyHook | undefined;
  /**
   * marks a context whose writes must run in a unit bound to it, a v3
   * datastore's; never undone
   */
  requireUnit(markDirty: MarkDirtyHook): void;
  requiresUnit(markDirty: MarkDirtyHook): boolean;
}

/**
 * an end that could not record its outcome, so given-up changes may still be
 * committed; the caller rethrows it rebuilt to carry the operation's failure
 * instead of logging it
 */
export abstract class UnrecordedEndError extends UserError {
  abstract during(failure: unknown): UnrecordedEndError;
}

export function rethrowUnrecordedEnd(
  endError: unknown,
  failure: unknown,
): void {
  if (endError instanceof UnrecordedEndError) throw endError.during(failure);
}
