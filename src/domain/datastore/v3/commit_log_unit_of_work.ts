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
 * Proposed ports for the commit-log unit of work (swamp-club#3233,
 * decisions 1 and 2 in "v3 domain model", `design/enablers/datastores.md`).
 *
 * Types only. Nothing implements or calls them yet: `StagedChange`,
 * `signalChange` and the legacy adapter are unchanged. The commit-store
 * issue implements them.
 *
 * @module
 */

import type { MarkDirtyHook } from "../datastore_sync_service.ts";
import type { UnitOfWork } from "../unit_of_work.ts";
import type { Op } from "./op.ts";
import type { PartitionKey } from "./partition_key.ts";

/**
 * One typed change a repository stages into a commit-log unit: the op it
 * makes (with its intent, record key and content), and the partition the
 * op's intent belongs to.
 *
 * Decision 1: repositories that run on a v3 datastore stage typed changes
 * through this sibling port, beside the path-only `StagedChange` they stage
 * today. A path alone cannot become a commit: the commit needs the intent
 * serve authorises on and the content the partition records.
 */
export interface TypedChange {
  readonly partition: PartitionKey;
  readonly op: Op;
}

/**
 * A unit of work that commits to the v3 commit log.
 *
 * - `stageOp` records a typed change; `stage` (path-only) stays for the
 *   changes a repository cannot type yet, and the adapter refuses those on
 *   v3 rather than guess.
 * - `commit` commits each partition touched, data partitions first and a
 *   workflow run's record last (decision 7).
 * - `abandon` discards the staged ops (decision 4).
 * - `checkpoint` commits each partition touched so far and keeps the unit
 *   open (decision 6).
 */
export interface CommitLogUnitOfWork extends UnitOfWork {
  stageOp(change: TypedChange): Promise<void>;
  checkpoint(): Promise<void>;
  /** The typed changes staged so far, in staging order. */
  stagedOps(): readonly TypedChange[];
}

/**
 * Decision 2: how any unit of work claims the repository context it serves.
 *
 * Today `signalChange` stages into the ambient unit only when
 * `legacyUnitOfWorkTarget(uow)` is the repository's own mark hook, which
 * recognises legacy units alone. A binding registry generalises that: each
 * adapter registers the units it builds against the hook of the repository
 * context they serve, and `signalChange` asks the registry. The legacy
 * adapter becomes one registrant; the commit-log adapter another.
 */
export interface UnitOfWorkBinding {
  /** Records that `uow` serves the repository context behind `markDirty`. */
  bind(uow: UnitOfWork, markDirty: MarkDirtyHook): void;
  /** The context `uow` serves, or undefined when it serves none. */
  boundHook(uow: UnitOfWork): MarkDirtyHook | undefined;
}
