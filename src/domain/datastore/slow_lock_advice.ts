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
 * a namespace scopes only the global lock; per-model locks are keyed by type
 * and id, so a slow wait there is concurrent runs on one instance and a
 * namespace changes nothing
 */

import { join, resolve } from "@std/path";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "./datastore_config.ts";

export const SLOW_LOCK_THRESHOLD_MS = 5_000;

export type LockScope =
  | { readonly kind: "global" }
  | {
    readonly kind: "model";
    readonly modelType: string;
    readonly modelId: string;
  };

export type SlowLockAdvice = "namespace" | "model-contention";

export interface SlowLockAdviceInput {
  readonly waitedMs: number;
  readonly scope: LockScope;
  readonly shareable: boolean;
  readonly namespace?: string;
}

export function slowLockAdvice(
  input: SlowLockAdviceInput,
): SlowLockAdvice | undefined {
  if (input.waitedMs <= SLOW_LOCK_THRESHOLD_MS) return undefined;
  if (input.scope.kind === "model") return "model-contention";
  if (!input.shareable || input.namespace) return undefined;
  return "namespace";
}

/**
 * extension datastores are remote and always shareable; a filesystem datastore
 * at the repo's own .swamp directory is not, any other path might be
 */
export function isShareableDatastore(
  config: DatastoreConfig,
  repoDir: string,
): boolean {
  if (isCustomDatastoreConfig(config)) return true;
  return resolve(repoDir, config.path) !== resolve(join(repoDir, ".swamp"));
}
