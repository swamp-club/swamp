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
 * The managed lockfile's sync port on a v3 datastore (swamp-club#3279).
 *
 * On v2 a filesystem datastore's lockfile is shared by being one file, and
 * an extension datastore's by a pull and a push under the global lock. A v3
 * checkout writes the lockfile into its own config tier, so the change is
 * shared by committing it: the publish stages the lockfile as a typed put in
 * the lockfile's partition, in the root the transaction runs in, and commits
 * at that root's checkpoint. Its fetch has nothing to do: the context caught
 * the read model up when it opened, and the writer lock keeps every other
 * process from writing until this one ends.
 *
 * @module
 */

import { relative, SEPARATOR } from "@std/path";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  LockfileChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import type { ManagedLockfileSyncPort } from "../../libswamp/extensions/managed_lockfile_transaction.ts";
import { currentRootUnitOfWork } from "../persistence/repo_unit_of_work.ts";
import { stageTyped } from "../persistence/unit_of_work_scope.ts";

/** Options for {@link createV3LockfileSync}. */
export interface V3LockfileSyncOptions {
  /** The hook of the v3 context the transaction's root is open over. */
  readonly markDirty: MarkDirtyHook;
  /** The lockfile, inside the config tier. */
  readonly lockfilePath: string;
  /** The config tier the lockfile lives in, whose key prefix is `config`. */
  readonly configBase: string;
}

/** The sync port of a managed lockfile transaction on a v3 datastore. */
export function createV3LockfileSync(
  options: V3LockfileSyncOptions,
): ManagedLockfileSyncPort {
  const { markDirty, lockfilePath, configBase } = options;
  const key = recordKeyOf([
    "config",
    ...relative(configBase, lockfilePath).split(SEPARATOR),
  ]);
  return {
    hydrate: () => Promise.resolve(),
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
        () => [new LockfileChanges().write(key, bytes)],
      );
      await root.checkpoint();
    },
  };
}
