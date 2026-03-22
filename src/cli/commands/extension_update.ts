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
import { resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import { resolveVaultsDir } from "../resolve_vaults_dir.ts";
import { resolveDriversDir } from "../resolve_drivers_dir.ts";
import { resolveDatastoresDir } from "../resolve_datastores_dir.ts";
import { resolveReportsDir } from "../resolve_reports_dir.ts";
import { resolveWorkflowsDir } from "../resolve_workflows_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import {
  type InstallContext,
  installExtension,
  parseExtensionRef,
} from "./extension_pull.ts";
import {
  consumeStream,
  createExtensionUpdateDeps,
  createLibSwampContext,
  extensionUpdate,
} from "../../libswamp/mod.ts";
import { createExtensionUpdateRenderer } from "../../presentation/renderers/extension_update.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const DEFAULT_SERVER_URL = "https://swamp.club";

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
}

export const extensionUpdateCommand = new Command()
  .name("update")
  .description(
    "Update installed extensions to latest versions.\n\nExamples:\n  swamp extension update              Update all installed extensions\n  swamp extension update @ns/name     Update a specific extension\n  swamp extension update --check      Show what's outdated without pulling",
  )
  .arguments("[extension:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--check", "Show what's outdated without pulling")
  .action(async function (options: AnyOptions, extensionArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "update",
    ]);
    cliCtx.logger.debug`Starting extension update`;

    // 1. Validate repo
    const repoDir = options.repoDir ?? ".";
    await requireInitializedRepo({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // 2. Resolve dirs from .swamp.yaml
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const workflowsDir = resolveWorkflowsDir(marker);
    const vaultsDir = resolveVaultsDir(marker);
    const driversDir = resolveDriversDir(marker);
    const datastoresDir = resolveDatastoresDir(marker);
    const reportsDir = resolveReportsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);

    // 3. Parse extension name if given
    let extensionName: string | undefined;
    if (extensionArg) {
      const ref = parseExtensionRef(extensionArg);
      extensionName = ref.name;
    }

    // 4. Wire deps — inject installExtension from CLI layer
    const serverUrl = resolveServerUrl();
    const extensionClient = new ExtensionApiClient(serverUrl);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createExtensionUpdateDeps({
      absoluteModelsDir,
      serverUrl,
      installExtension: async (name: string, version: string) => {
        const installCtx: InstallContext = {
          extensionClient,
          logger: cliCtx.logger,
          modelsDir,
          workflowsDir,
          vaultsDir,
          driversDir,
          datastoresDir,
          reportsDir,
          repoDir,
          force: true,
          alreadyPulled: new Set(),
          depth: 0,
        };
        await installExtension({ name, version }, installCtx);
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
