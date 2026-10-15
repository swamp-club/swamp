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
 * Dormant: nothing in production calls it yet. The sidecar still takes its
 * replica from `v3ReplicaSetting()` alone; Phase 4E switches those call
 * sites to {@link resolveV3ReplicaSetting}. A fitness rule in
 * `integration/datastore_v3_rules_test.ts` pins both.
 *
 * @module
 */

import type { DatastoreProvider } from "../../../domain/datastore/datastore_provider.ts";
import {
  parseV3ReplicaTarget,
  type V3ReplicaTarget,
} from "../../../domain/datastore/replica_target.ts";
import { UserError } from "../../../domain/errors.ts";
import { type V3ReplicaSetting, v3ReplicaSetting } from "./replica_setting.ts";

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
