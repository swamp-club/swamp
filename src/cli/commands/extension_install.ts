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

import { Command } from "@cliffy/command";
import { join, resolve } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  consumeStream,
  createLibSwampContext,
  extensionInstall,
  resolveServerUrl,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { createExtensionInstallRenderer } from "../../presentation/renderers/extension_install.ts";
import { resolveSkillsDir } from "../../domain/repo/skill_dirs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionInstallCommand = new Command()
  .name("install")
  .description(
    "Restore pulled extensions from the lockfile.\n\nReads upstream_extensions.json and re-pulls any extensions whose source\nfiles are missing. Use after cloning a repo or in CI.\nTo add a new extension, use 'swamp extension pull <name>' instead.",
  )
  .example("Restore extensions from lockfile", "swamp extension install")
  .arguments("[unexpected:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, unexpected?: string) {
    if (unexpected) {
      throw new UserError(
        `'swamp extension install' takes no arguments.\n` +
          `To add a new extension, use: swamp extension pull ${unexpected}`,
      );
    }

    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "install",
    ]);
    cliCtx.logger.debug`Starting extension install`;

    // 1. Validate repo
    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepo({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // 2. Resolve lockfile path
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    // 3. Warn (don't block) on legacy layout. extension install is the
    // migration mechanism for missing-files state: it re-installs into
    // the new per-extension layout automatically.
    await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => cliCtx.logger.warn(msg),
    );

    // 4. Resolve skills destination (tool-aware). Per-extension
    // models/workflows/vaults/drivers/datastores/reports destinations
    // are derived inside installExtension from each extension's name.
    const tool = marker?.tool ?? "claude";
    const skillsDir = resolveSkillsDir(repoDir, tool);

    // 5. Wire deps and execute
    const serverUrl = resolveServerUrl();
    const client = new ExtensionApiClient(serverUrl);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createExtensionInstallRenderer(cliCtx.outputMode);

    await consumeStream(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir,
        createInstallContext: (_name, _version) => ({
          getExtension: (n) => client.getExtension(n),
          downloadArchive: (n, v) => client.downloadArchive(n, v),
          getChecksum: (n, v) => client.getChecksum(n, v),
          logger: cliCtx.logger,
          lockfilePath,
          skillsDir,
          repoDir,
          force: true,
          alreadyPulled: new Set(),
          depth: 0,
        }),
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension install command completed");
  });
