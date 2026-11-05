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

import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { resolveSourceBaseDirs } from "../infrastructure/persistence/git_worktree.ts";
import {
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import type { ResolvedSourceDirs } from "../domain/repo/swamp_sources.ts";
import type {
  ReadOnlyRepo,
  ReadOnlyRepoOpener,
} from "../serve/local/read_only_dashboard.ts";
import {
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "./repo_context.ts";
import { configureStartupExtensions } from "./startup_extensions.ts";

/**
 * Opens a repo the way `swamp dashboard --child` does. Without extensions no
 * loader is configured, so only built-in types resolve.
 */
export const openReadOnlyEngineRepo: ReadOnlyRepoOpener = (repoDir, options) =>
  openReadOnly(repoDir, options);

async function openReadOnly(
  repoDir: string,
  { extensions }: { readonly extensions: boolean },
): Promise<ReadOnlyRepo & { dispose(): Promise<void> }> {
  let disposeExtensions = () => {};
  if (extensions) {
    const marker = await new RepoMarkerRepository().read(
      RepoPath.create(repoDir),
    );
    let resolvedSources: ResolvedSourceDirs[] = [];
    const sourcesConfig = await readSwampSources(repoDir);
    if (sourcesConfig) {
      const { baseDir, legacyBaseDir } = await resolveSourceBaseDirs(repoDir);
      resolvedSources = (await resolveSourceExtensionDirs(
        await expandSourcePaths(sourcesConfig, repoDir, baseDir, legacyBaseDir),
      )).resolved;
    }
    disposeExtensions = await configureStartupExtensions({
      repoDir,
      marker,
      resolvedSources,
      deferredWarnings: [],
      quiet: true,
      deferCatalog: true,
    });
  }
  try {
    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
    const repo = await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: "json",
    });
    return {
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
      datastoreConfig,
      datastoreResolver: repo.datastoreResolver,
      vaultsDir: repo.vaultsDir,
      defaultVault: repo.marker?.defaultVault,
      dispose: () => {
        repo.repoContext.catalogStore.close();
        disposeExtensions();
        return Promise.resolve();
      },
    };
  } catch (error) {
    disposeExtensions();
    throw error;
  }
}
