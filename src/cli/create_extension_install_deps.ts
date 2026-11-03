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

import { relative, resolve } from "@std/path";
import type { Logger } from "@logtape/logtape";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { resolveUniqueLocalSkillsDirs } from "../domain/repo/skill_dirs.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import { loadIdentity } from "./load_identity.ts";
import type { ExtensionInstallDeps } from "../libswamp/extensions/install.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { resolveServerUrl } from "../libswamp/extensions/pull.ts";
import { resolveManagedLockfileForWrite } from "./repo_context.ts";
import { createDefaultExtensionArchiveCache } from "../infrastructure/persistence/extension_archive_cache.ts";

export async function createExtensionInstallDeps(
  repoDir: string,
  logger: Logger,
  options?: {
    lockfilePath?: string;
  },
): Promise<ExtensionInstallDeps> {
  // Absolutize up front. Downstream code joins `repoDir` with relative
  // file paths and passes both to filesystem helpers that compare paths
  // via `startsWith` — a relative `.` breaks the comparison silently
  // (empty-dir cleanup no-ops, producing stale directory shells).
  const absoluteRepoDir = resolve(repoDir);
  const repoPath = RepoPath.create(absoluteRepoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  // refuses to restore into a guessed managed config base, since install would
  // record into a lockfile the datastore never sees
  const lockfilePath = options?.lockfilePath ??
    (await resolveManagedLockfileForWrite(absoluteRepoDir, marker))
      .lockfilePath;
  const tools = marker?.tools?.length ? marker.tools : ["claude"];
  const absoluteSkillsDirs = resolveUniqueLocalSkillsDirs(
    absoluteRepoDir,
    tools,
  );
  // `entry.files[]` paths in the lockfile are relative to the repo
  // root, so the skill-dir filter in needsInstallOrMigration /
  // sweepLegacyPaths must compare against a repo-relative skillsDir.
  // The InstallContext's `skillsDirs` stays absolute — pull.ts joins
  // them with the destination dir and that path is independent of the
  // lockfile's relative-path convention.
  const skillsDirsRelative = absoluteSkillsDirs.map((d) =>
    relative(absoluteRepoDir, d)
  );

  const serverUrl = resolveServerUrl();
  const identity = await loadIdentity();
  const client = new ExtensionApiClient(serverUrl, identity);
  const apiKey = identity.bearerToken;
  const archiveCache = createDefaultExtensionArchiveCache();

  return {
    lockfilePath,
    repoDir: absoluteRepoDir,
    skillsDirsRelative,
    createInstallContext: async (_name, _version) => ({
      getExtension: (n) => client.getExtension(n, apiKey),
      downloadArchive: (n, v, ch) => client.downloadArchive(n, v, apiKey, ch),
      getChecksum: (n, v, ch) => client.getChecksum(n, v, apiKey, ch),
      archiveCache,
      logger,
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      skillsDirs: absoluteSkillsDirs,
      repoDir: absoluteRepoDir,
      force: true,
      alreadyPulled: new Set(),
      depth: 0,
    }),
  };
}
