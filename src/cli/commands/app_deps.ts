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

import type { Logger } from "@logtape/logtape";
import { readHeldPlatforms } from "../../serve/app_platform_assets.ts";
import type { LibSwampContext } from "../../libswamp/context.ts";
import type { AppDeps } from "../../libswamp/apps/apps.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { UserError } from "../../domain/errors.ts";
import { ControlPlaneAppApprovalRepository } from "../../infrastructure/persistence/control_plane_app_store.ts";
import { FilesystemAppCatalog } from "../../infrastructure/persistence/filesystem_app_catalog.ts";
import { resolveMountedSourceRoots } from "../../infrastructure/persistence/swamp_sources_repository.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import {
  libSwampContextForRepo,
  localServeControlPlane,
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "../repo_context.ts";

// a v2 custom datastore's control-plane store, where approvals live, is reachable only through serve
export async function localAppDeps(
  repoDir: string,
  outputMode: OutputMode,
  logger: Logger,
): Promise<{ ctx: LibSwampContext; deps: AppDeps }> {
  const { datastoreConfig, engine } = await resolveDatastoreForRepo(repoDir);
  if (isCustomDatastoreConfig(datastoreConfig) && engine !== "v3") {
    throw new UserError(
      `App approvals of a "${datastoreConfig.type}" datastore are kept in its shared control-plane store. ` +
        "Manage apps through the server instead: add --server <url>, or set SWAMP_SERVE_URL.",
    );
  }
  const { repoDir: resolvedRepoDir, repoContext } =
    await requireInitializedRepoReadOnly({ repoDir, outputMode });
  const store = await localServeControlPlane(resolvedRepoDir);
  return {
    ctx: libSwampContextForRepo(repoContext, { logger }),
    deps: {
      catalog: new FilesystemAppCatalog({
        repoDir: resolvedRepoDir,
        sourceDirs: () => resolveMountedSourceRoots(resolvedRepoDir),
        followDevServers: true,
      }),
      approvals: new ControlPlaneAppApprovalRepository(store),
      now: () => new Date(),
      platforms: () => readHeldPlatforms(),
    },
  };
}
