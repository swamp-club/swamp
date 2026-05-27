// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { join, relative, resolve } from "@std/path";
import type { Logger } from "@logtape/logtape";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { resolveSkillsDir } from "../domain/repo/skill_dirs.ts";
import { resolvePrimaryTool } from "../domain/repo/primary_tool.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import { loadIdentity } from "./load_identity.ts";
import {
  type ExtensionInstallDeps,
  LockfileRepository,
  resolveServerUrl,
} from "../libswamp/mod.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";

/**
 * Wires `ExtensionInstallDeps` from a repo directory and a logger.
 *
 * Shared by `swamp extension install` (its primary use) and
 * `swamp repo upgrade` (which runs the install pass to complete any
 * legacy-layout migration). Reading the marker is the only I/O — the
 * returned deps wrap a fresh `ExtensionApiClient` and construct install
 * contexts lazily per-entry.
 */
export async function createExtensionInstallDeps(
  repoDir: string,
  logger: Logger,
): Promise<ExtensionInstallDeps> {
  // Absolutize up front. Downstream code joins `repoDir` with relative
  // file paths and passes both to filesystem helpers that compare paths
  // via `startsWith` — a relative `.` breaks the comparison silently
  // (empty-dir cleanup no-ops, producing stale directory shells).
  const absoluteRepoDir = resolve(repoDir);
  const repoPath = RepoPath.create(absoluteRepoDir);
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);
  const modelsDir = resolveModelsDir(marker);
  const absoluteModelsDir = resolve(absoluteRepoDir, modelsDir);
  const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
  const tool = resolvePrimaryTool(marker);
  const absoluteSkillsDir = resolveSkillsDir(absoluteRepoDir, tool);
  // `entry.files[]` paths in the lockfile are relative to the repo
  // root, so the skill-dir filter in needsInstallOrMigration /
  // sweepLegacyPaths must compare against a repo-relative skillsDir.
  // The InstallContext's `skillsDir` stays absolute — pull.ts joins it
  // with the destination dir and that path is independent of the
  // lockfile's relative-path convention. Two fields with the same
  // logical role but different conventions; keep them named distinctly.
  const skillsDirRelative = relative(absoluteRepoDir, absoluteSkillsDir);

  const serverUrl = resolveServerUrl();
  const identity = await loadIdentity();
  const client = new ExtensionApiClient(serverUrl, identity);

  return {
    lockfilePath,
    repoDir: absoluteRepoDir,
    skillsDirRelative,
    createInstallContext: async (_name, _version) => ({
      getExtension: (n) => client.getExtension(n),
      downloadArchive: (n, v) => client.downloadArchive(n, v),
      getChecksum: (n, v) => client.getChecksum(n, v),
      logger,
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      skillsDir: absoluteSkillsDir,
      repoDir: absoluteRepoDir,
      force: true,
      alreadyPulled: new Set(),
      depth: 0,
    }),
  };
}
