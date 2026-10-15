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
 * Turns a datastore provider's replica target into the replica its
 * Litestream sidecar replicates to (swamp-club#3507).
 *
 * Also hands lineage collection the provider's replica paths
 * (swamp-club#3531), through {@link resolveV3ReplicaPaths}.
 *
 * Dormant: nothing in production calls it yet. The sidecar still takes its
 * replica from `v3ReplicaSetting()` alone; Phase 4E switches those call
 * sites to {@link resolveV3ReplicaSetting}, and passes
 * {@link resolveV3ReplicaPaths} to lineage collection. Fitness rules in
 * `integration/datastore_v3_rules_test.ts` pin all of it.
 *
 * @module
 */

import type { DatastoreProvider } from "../../../domain/datastore/datastore_provider.ts";
import type { ReplicaPathStore } from "../../../domain/datastore/replica_path_store.ts";
import {
  parseV3ReplicaTarget,
  type V3ReplicaTarget,
} from "../../../domain/datastore/replica_target.ts";
import { UserError } from "../../../domain/errors.ts";
import { getSwampLogger } from "../../logging/logger.ts";
import {
  replicaRootOf,
  type V3ReplicaSetting,
  v3ReplicaSetting,
} from "./replica_setting.ts";

const logger = getSwampLogger(["datastore", "v3", "replication"]);

/** The replica Litestream replicates to for `target`. */
export function replicaSettingFromTarget(
  target: V3ReplicaTarget,
): V3ReplicaSetting {
  if (target.type === "gcs") {
    return { type: "gcs", bucket: target.bucket, path: target.prefix };
  }
  return {
    type: "s3",
    bucket: target.bucket,
    path: target.prefix,
    ...(target.region !== undefined ? { region: target.region } : {}),
    ...(target.endpoint !== undefined ? { endpoint: target.endpoint } : {}),
    ...(target.forcePathStyle !== undefined
      ? { forcePathStyle: target.forcePathStyle }
      : {}),
  };
}

/**
 * The replica a v3 writer of the `datastoreType` datastore replicates to:
 * the internal replica setting (`v3ReplicaSetting()`) when it is set, which
 * tests use, and otherwise the provider's own replica target.
 *
 * @throws UserError when the provider has no `replicaTarget()`, refuses
 * in it, or returns a target swamp cannot use
 */
export function resolveV3ReplicaSetting(
  provider: Pick<DatastoreProvider, "replicaTarget">,
  datastoreType: string,
): V3ReplicaSetting {
  const setting = v3ReplicaSetting();
  if (setting !== undefined) return setting;
  if (provider.replicaTarget === undefined) {
    throw new UserError(
      `The ${datastoreType} datastore does not declare replicaTarget(), so it ` +
        `cannot host a v3 datastore: nothing says where its Litestream ` +
        `replica lives. Update the datastore extension to a version that ` +
        `declares it.`,
    );
  }
  let target: unknown;
  try {
    target = provider.replicaTarget();
  } catch (error) {
    // Extensions cannot import core's UserError, so a refusal arrives as
    // whatever they threw.
    if (error instanceof UserError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new UserError(
      `The ${datastoreType} datastore cannot host a v3 datastore: ${reason}`,
    );
  }
  return replicaSettingFromTarget(parseV3ReplicaTarget(target, datastoreType));
}

/**
 * A provider's replica paths and the replica root they are under: the root
 * of the provider's own replica target. Lineage collection uses the store
 * only for that root, so a replica set elsewhere (the internal setting
 * tests use) never has paths removed from the provider's bucket.
 */
export interface V3ReplicaPaths {
  /** `replicaRootOf` the provider's replica target. */
  readonly root: string;
  readonly store: ReplicaPathStore;
}

/**
 * The provider's replica paths, which lineage collection removes a
 * replaced lineage's bucket path through, or undefined when the provider
 * has none, or no usable replica target to bind them to. A provider that
 * throws is logged and treated as having none: collection then keeps the
 * paths and records, as it does without the capability, and never fails
 * a command.
 */
export function resolveV3ReplicaPaths(
  provider: Pick<DatastoreProvider, "replicaPaths" | "replicaTarget">,
  datastoreType: string,
): V3ReplicaPaths | undefined {
  if (
    provider.replicaPaths === undefined ||
    provider.replicaTarget === undefined
  ) {
    return undefined;
  }
  try {
    const target = parseV3ReplicaTarget(
      provider.replicaTarget(),
      datastoreType,
    );
    return {
      root: replicaRootOf(replicaSettingFromTarget(target)),
      store: provider.replicaPaths(),
    };
  } catch (error) {
    logger
      .warn`The ${datastoreType} datastore's replica paths cannot be used, so old replication lineage paths are kept: ${error}`;
    return undefined;
  }
}
