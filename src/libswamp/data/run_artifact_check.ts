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
 * on v3 a removed version can be rewritten and compaction drops the original
 * commits, so a run record's name@version may be another writer's;
 * resolveRunArtifact decides by sha256, else by run or time
 */

import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import { resolveRunArtifact } from "../../domain/datastore_v3/run_artifact_resolution.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { RunArtifactCheck } from "../../domain/data/workflow_data_service.ts";

export async function sha256Hex(content: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(content).buffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
}

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
