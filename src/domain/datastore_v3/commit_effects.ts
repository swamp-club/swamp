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
 * What a landed commit changes for a serve node holding a copy of the
 * datastore (swamp-club#4120). On v3 serve keeps its catalog, its access
 * policy and its extensions current by applying each commit it sees, from
 * its own writes and, on a follower, from the leader's commit feed, in
 * place of v2's pollers. Decided from the commit's partition alone, so it
 * needs nothing but the commit.
 *
 * @module
 */

import { isControlPlaneModelType } from "../models/control_plane_types.ts";
import type { PartitionKey } from "./partition_key.ts";

/** One thing a commit can change for serve. */
export type CommitEffect =
  /** A model, workflow or vault definition: the catalog is rebuilt. */
  | "config"
  /** The extension lockfile: serve reloads its extensions. */
  | "lockfile"
  /** Grants, groups, tokens or workers: the access policy is reloaded. */
  | "access"
  /** Model data, run records or auto-definitions: the catalog is rebuilt. */
  | "runtime";

/** What a commit to `partition` changes. */
export function commitEffectOf(partition: PartitionKey): CommitEffect {
  const identity = partition.identity;
  switch (identity.kind) {
    case "config":
      return "config";
    case "lockfile":
      return "lockfile";
    case "model":
      return isControlPlaneModelType(identity.type) ? "access" : "runtime";
    case "run":
    case "definition":
      return "runtime";
  }
}

/** The effects a batch of commits to `partitions` has, each once. */
export function commitEffectsOf(
  partitions: Iterable<PartitionKey>,
): ReadonlySet<CommitEffect> {
  const effects = new Set<CommitEffect>();
  for (const partition of partitions) effects.add(commitEffectOf(partition));
  return effects;
}
