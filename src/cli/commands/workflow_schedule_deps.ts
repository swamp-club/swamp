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
import { FileSystemControlPlaneStore } from "../../infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { readServeConfigFile } from "../../serve/serve_config.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import type { Logger } from "@logtape/logtape";
import {
  libSwampContextForRepo,
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "../repo_context.ts";

/**
 * The schedule operations' deps for a command run without `--server`
 * (swamp-club#3522). Pauses go to the control-plane store `swamp serve`
 * keeps for a filesystem datastore (`.swamp/_control`), where a serve on
 * this repository checks them at its next fire. The repository is opened
 * read-only: a running serve holds the writer lease, and a pause is most
 * needed while serve runs.
 *
 * A custom datastore's pauses live in its shared control-plane store, which
 * serve opens bound to its namespace; they are set through serve.
 */
export async function localWorkflowScheduleDeps(
  repoDir: string,
  outputMode: OutputMode,
  logger: Logger,
): Promise<{ ctx: LibSwampContext; deps: WorkflowScheduleDeps }> {
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  if (isCustomDatastoreConfig(datastoreConfig)) {
    throw new UserError(
      `Schedule pauses of a "${datastoreConfig.type}" datastore are kept in its shared control-plane store. ` +
        "Pause and resume through the server instead: add --server <url>, or set SWAMP_SERVE_URL.",
    );
  }
  const { repoDir: resolvedRepoDir, repoContext } =
    await requireInitializedRepoReadOnly({ repoDir, outputMode });
  const deps = createWorkflowScheduleDeps({
    workflowRepo: repoContext.workflowRepo,
    controlPlaneStore: new FileSystemControlPlaneStore(
      swampPath(resolvedRepoDir),
    ),
    overrideSchedules: async () =>
      overrideSchedulesOf(
        Object.entries(
          (await readServeConfigFile(resolvedRepoDir))?.triggers ?? {},
        ),
      ),
  });
  return { ctx: libSwampContextForRepo(repoContext, { logger }), deps };
}
