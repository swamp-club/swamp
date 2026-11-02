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
 * the put expects the lockfile record as the transaction found it in the store,
 * so a change another checkout landed meanwhile refuses the publish rather than
 * being overwritten
 */

import { relative, SEPARATOR } from "@std/path";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  LockfileChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import type { PutExpect } from "../../domain/datastore_v3/op.ts";
import type { ManagedLockfileSyncPort } from "../../libswamp/extensions/managed_lockfile_transaction.ts";
import { sha256Hex } from "../persistence/config_staging.ts";
import {
  type CommitLogEngine,
  currentRootUnitOfWork,
} from "../persistence/repo_unit_of_work.ts";
import { stageTyped } from "../persistence/unit_of_work_scope.ts";

export interface V3LockfileSyncOptions {
  readonly markDirty: MarkDirtyHook;
  readonly lockfilePath: string;
  readonly configBase: string;
  /**
   * the version of the lockfile record the checkout last caught up to, which
   * the publish expects; without one it expects nothing
   */
  readonly commitLog?: Pick<CommitLogEngine, "storedVersion">;
}

export function createV3LockfileSync(
  options: V3LockfileSyncOptions,
): ManagedLockfileSyncPort {
  const { markDirty, lockfilePath, configBase, commitLog } = options;
  const key = recordKeyOf([
    "config",
    ...relative(configBase, lockfilePath).split(SEPARATOR),
  ]);
  // The version the next publish replaces: the lockfile record as the
  // transaction found it, then each version this transaction published.
  let replaces: PutExpect | undefined;
  return {
    hydrate: async () => {
      replaces = await commitLog?.storedVersion?.(
        new LockfileChanges().partition,
        key.toString(),
      );
    },
    publish: async () => {
      const root = currentRootUnitOfWork(markDirty);
      if (root === undefined) {
        throw new Error(
          "a v3 lockfile publish ran outside its transaction's root unit of work",
        );
      }
      const bytes = await Deno.readFile(lockfilePath);
      await stageTyped(
        markDirty,
        () => [new LockfileChanges().write(key, bytes, replaces)],
      );
      await root.checkpoint();
      replaces = { sha256: await sha256Hex(bytes) };
    },
  };
}
