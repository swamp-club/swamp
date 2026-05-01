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
  createInstallContext,
  installExtension,
  parseExtensionRef,
} from "./extension_pull.ts";
import {
  consumeStream,
  createExtensionUpdateDeps,
  createLibSwampContext,
  extensionUpdate,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import { createExtensionUpdateRenderer } from "../../presentation/renderers/extension_update.ts";
import { resolveSkillsDir } from "../../domain/repo/skill_dirs.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export const extensionUpdateCommand = new Command()
  .name("update")
  .description("Update installed extensions to latest versions")
  .example("Update all extensions", "swamp extension update")
  .example("Update one extension", "swamp extension update @stack72/aws-ec2")
  .example("Check for updates", "swamp extension update --check")
  .arguments("[extension:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--check", "Show what's outdated without pulling")
  .action(async function (options: AnyOptions, extensionArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "update",
    ]);
    cliCtx.logger.debug`Starting extension update`;

    // 1. Validate repo
    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepo({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // 2. Resolve dirs from .swamp.yaml
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    // Per-extension models/workflows/vaults/drivers/datastores/reports
    // destinations are derived inside installExtension from the
    // extension's scoped name. Only skillsDir is tool-dependent.
    const tool = resolvePrimaryTool(marker);
    const skillsDir = resolveSkillsDir(repoDir, tool);

    // 3. Warn (don't block) on legacy layout. update pulls new versions
    // which write to the per-extension subtree, migrating each extension
    // as it goes.
    await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => cliCtx.logger.warn(msg),
    );

    // 4. Parse extension name if given
    let extensionName: string | undefined;
    if (extensionArg) {
      const ref = parseExtensionRef(extensionArg);
      extensionName = ref.name;
    }

    // 4. Wire deps — inject installExtension from CLI layer
    const serverUrl = resolveServerUrl();

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionUpdateDeps({
      lockfilePath,
      serverUrl,
      installExtension: async (name: string, version: string) => {
        const installCtx = createInstallContext(serverUrl, {
          logger: cliCtx.logger,
          lockfilePath,
          skillsDir,
          repoDir,
          force: true,
        });
        return await installExtension({ name, version }, installCtx);
      },
    });

    // 5. Execute and render
    const renderer = createExtensionUpdateRenderer(cliCtx.outputMode);
    await consumeStream(
      extensionUpdate(ctx, deps, {
        extensionName,
        checkOnly: !!options.check,
      }),
      renderer.handlers(),
    );
  });
