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

import {
  createWorkflowScheduleDeps,
  overrideSchedulesOf,
  type WorkflowScheduleDeps,
} from "../../libswamp/workflows/schedule.ts";
import type { LibSwampContext } from "../../libswamp/context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { UserError } from "../../domain/errors.ts";
import { readServeConfigFile } from "../../serve/serve_config.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import type { Logger } from "@logtape/logtape";
import {
  libSwampContextForRepo,
  localServeControlPlane,
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "../repo_context.ts";

/**
 * pauses go to the control-plane store serve keeps (the datastore's own on v3);
 * the repository is opened read-only since serve holds the writer lease; a v2
 * custom datastore's pauses go through serve
 */
export async function localWorkflowScheduleDeps(
  repoDir: string,
  outputMode: OutputMode,
  logger: Logger,
): Promise<{ ctx: LibSwampContext; deps: WorkflowScheduleDeps }> {
  const { datastoreConfig, engine } = await resolveDatastoreForRepo(repoDir);
  if (isCustomDatastoreConfig(datastoreConfig) && engine !== "v3") {
    throw new UserError(
      `Schedule pauses of a "${datastoreConfig.type}" datastore are kept in its shared control-plane store. ` +
        "Pause and resume through the server instead: add --server <url>, or set SWAMP_SERVE_URL.",
    );
  }
  const { repoDir: resolvedRepoDir, repoContext } =
    await requireInitializedRepoReadOnly({ repoDir, outputMode });
  const deps = createWorkflowScheduleDeps({
    workflowRepo: repoContext.workflowRepo,
    controlPlaneStore: await localServeControlPlane(resolvedRepoDir),
    overrideSchedules: async () =>
      overrideSchedulesOf(
        Object.entries(
          (await readServeConfigFile(resolvedRepoDir))?.triggers ?? {},
        ),
      ),
  });
  return { ctx: libSwampContextForRepo(repoContext, { logger }), deps };
}
