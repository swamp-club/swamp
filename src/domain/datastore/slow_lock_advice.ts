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
 * Decides what a slow lock acquisition should tell the user.
 *
 * A namespace scopes the datastore global lock, so it only helps when
 * another repo can reach that lock. Per-model locks are already keyed by
 * model type and id: a slow wait there comes from concurrent runs against
 * one model instance, and a namespace changes nothing (swamp-club#2941).
 */

import { join, resolve } from "@std/path";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "./datastore_config.ts";

/** Waits longer than this (ms) are reported as slow. */
export const SLOW_LOCK_THRESHOLD_MS = 5_000;

/** Which lock a slow acquisition waited on. */
export type LockScope =
  | { readonly kind: "global" }
  | {
    readonly kind: "model";
    readonly modelType: string;
    readonly modelId: string;
  };

/** What a slow acquisition should say, if anything. */
export type SlowLockAdvice = "namespace" | "model-contention";

/** Inputs to {@link slowLockAdvice}. */
export interface SlowLockAdviceInput {
  /** How long the acquisition waited, in ms. */
  readonly waitedMs: number;
  /** Which lock was waited on. */
  readonly scope: LockScope;
  /** Whether another repo can reach this datastore. */
  readonly shareable: boolean;
  /** The datastore namespace, if one is set. */
  readonly namespace?: string;
}

/**
 * Returns the advice for a lock acquisition, or `undefined` when the wait
 * was not slow or no advice would help.
 *
 * - Per-model lock: name the real cause, concurrent runs on one instance.
 * - Global lock on a shareable datastore with no namespace: suggest one.
 * - Anything else: say nothing.
 */
export function slowLockAdvice(
  input: SlowLockAdviceInput,
): SlowLockAdvice | undefined {
  if (input.waitedMs <= SLOW_LOCK_THRESHOLD_MS) return undefined;
  if (input.scope.kind === "model") return "model-contention";
  if (!input.shareable || input.namespace) return undefined;
  return "namespace";
}

/**
 * Whether another repo can reach this datastore, and so share its global
 * lock. Extension datastores are remote and always can. A filesystem
 * datastore at the repo's own `.swamp` directory cannot; one at any other
 * path might.
 */
export function isShareableDatastore(
  config: DatastoreConfig,
  repoDir: string,
): boolean {
  if (isCustomDatastoreConfig(config)) return true;
  return resolve(repoDir, config.path) !== resolve(join(repoDir, ".swamp"));
}
