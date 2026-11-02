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
 * not called in production yet: the sidecar still takes its replica from
 * v3ReplicaSetting() alone
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
 * the internal replica setting wins when set, which tests use; otherwise the
 * provider's own replica target
 */
export function resolveV3ReplicaSetting(
  provider: Pick<DatastoreProvider, "replicaTarget">,
  datastoreType: string,
): V3ReplicaSetting {
  const setting = v3ReplicaSetting();
  if (setting !== undefined) return setting;
  return resolveV3ProviderReplica(provider, datastoreType);
}

/**
 * ignores the internal setting: what a v3 bucket datastore replicates to in
 * production, and the root its local copy is keyed by; setup calls it so the
 * provider's refusals surface as they are
 */
export function resolveV3ProviderReplica(
  provider: Pick<DatastoreProvider, "replicaTarget">,
  datastoreType: string,
): V3ReplicaSetting {
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
 * lineage collection uses the store only for the provider's own root, so a
 * replica set elsewhere (the internal setting) never has paths removed from the
 * provider's bucket
 */
export interface V3ReplicaPaths {
  readonly root: string;
  readonly store: ReplicaPathStore;
}

/**
 * a provider that throws is logged and treated as having none: collection then
 * keeps the paths and records, and never fails a command
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
      root: replicaRootOf(replicaSettingFromTarget(target)).value,
      store: provider.replicaPaths(),
    };
  } catch (error) {
    logger
      .warn`The ${datastoreType} datastore's replica paths cannot be used, so old replication lineage paths are kept: ${error}`;
    return undefined;
  }
}
