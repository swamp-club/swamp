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

/** decided from the commit's partition alone, so it needs nothing but the commit */

import {
  isControlPlaneModelType,
  isIntegrationModelType,
} from "../models/control_plane_types.ts";
import type { PartitionKey } from "./partition_key.ts";

export type CommitEffect =
  | "config"
  | "lockfile"
  | "access"
  | "integrations"
  | "runtime";

export function commitEffectOf(partition: PartitionKey): CommitEffect {
  const identity = partition.identity;
  switch (identity.kind) {
    case "config":
      return "config";
    case "lockfile":
      return "lockfile";
    case "model":
      if (isIntegrationModelType(identity.type)) return "integrations";
      return isControlPlaneModelType(identity.type) ? "access" : "runtime";
    case "run":
    case "definition":
      return "runtime";
  }
}

export function commitEffectsOf(
  partitions: Iterable<PartitionKey>,
): ReadonlySet<CommitEffect> {
  const effects = new Set<CommitEffect>();
  for (const partition of partitions) effects.add(commitEffectOf(partition));
  return effects;
}
