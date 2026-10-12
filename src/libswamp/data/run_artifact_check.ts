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
 * Resolving a run's data artifacts on a v3 datastore (swamp-club#3279).
 *
 * A version removed by `delete`, `data gc` or `prune` can be written again
 * on v3, and history compaction removes the commits that held the original,
 * so the live `name@version` a run record names may be another writer's
 * content. `resolveRunArtifact` (swamp-club#3258) decides whether it is the
 * run's: by the ref's `sha256` when it records one, else by the run that
 * wrote it or the time it was written. v2 never writes a version again and
 * takes no check.
 *
 * @module
 */

import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import { resolveRunArtifact } from "../../domain/datastore_v3/run_artifact_resolution.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { RunArtifactCheck } from "../../domain/data/workflow_data_service.ts";

/** The SHA-256 of `content`, as lowercase hex. */
export async function sha256Hex(content: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(content).buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * The check a workflow run's artifacts go through on a v3 datastore;
 * undefined on v2.
 */
export function v3RunArtifactCheck(
  datastoreResolver: DatastorePathResolver | undefined,
  dataRepo: Pick<UnifiedDataRepository, "getContent">,
): RunArtifactCheck | undefined {
  if (resolverEngine(datastoreResolver) !== "v3") return undefined;
  return async (artifact, data, owner, run) => {
    const content = await dataRepo.getContent(
      owner.modelType,
      owner.modelId,
      data.name,
      data.version,
    );
    const resolution = resolveRunArtifact(
      artifact,
      {
        workflowRunId: run.id,
        startedAt: run.startedAt ?? new Date(0),
        ...(run.completedAt !== undefined
          ? { completedAt: run.completedAt }
          : {}),
      },
      content === null
        ? undefined
        : { metadata: data.toData(), sha256: await sha256Hex(content) },
    );
    return resolution.kind === "available";
  };
}
