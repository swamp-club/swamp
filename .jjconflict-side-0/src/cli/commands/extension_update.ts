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
import { UserError } from "../../domain/errors.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import {
  type InstallContext,
  installExtension,
  parseExtensionRef,
} from "./extension_pull.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";
import {
  buildUpdateResult,
  checkExtensionVersion,
  type ExtensionUpdateStatus,
} from "../../domain/extensions/extension_update_service.ts";
import {
  renderExtensionNotInstalled,
  renderExtensionUpdateCheck,
  renderExtensionUpdateProgress,
  renderExtensionUpdateResult,
  renderNoExtensionsInstalled,
} from "../../presentation/output/extension_update_output.ts";

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
    const ctx = createContext(options as GlobalOptions, [
      "extension",
      "update",
    ]);
    ctx.logger.debug`Starting extension update`;

    // 1. Validate repo
    const repoDir = options.repoDir ?? ".";
    await requireInitializedRepo({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // 2. Resolve models dir and workflows dir from .swamp.yaml
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

    // 3. Read installed extensions
    const upstream = await readUpstreamExtensions(absoluteModelsDir);
    const installedNames = Object.keys(upstream);

    if (installedNames.length === 0) {
      renderNoExtensionsInstalled(ctx.outputMode);
      return;
    }

    // 4. If specific extension given, validate it exists
    let targetNames: string[];
    if (extensionArg) {
      const ref = parseExtensionRef(extensionArg);
      if (!upstream[ref.name]) {
        renderExtensionNotInstalled(ref.name, ctx.outputMode);
        throw new UserError(
          `Extension ${ref.name} is not installed. Use 'swamp extension pull ${ref.name}' to install it.`,
        );
      }
      targetNames = [ref.name];
    } else {
      targetNames = installedNames;
    }

    // 5. Resolve server URL and create API client
    const serverUrl = resolveServerUrl();
    const extensionClient = new ExtensionApiClient(serverUrl);

    // 6. Check each extension for updates
    const statuses: ExtensionUpdateStatus[] = [];
    for (const name of targetNames) {
      const installedVersion = upstream[name].version;

      let latestVersion: string | null = null;
      try {
        const extInfo = await extensionClient.getExtension(name);
        latestVersion = extInfo?.latestVersion ?? null;
      } catch {
        // Network failure — record as not_found
        statuses.push({
          status: "not_found",
          name,
          installedVersion,
          error: `Failed to fetch registry info for ${name}.`,
        });
        continue;
      }

      statuses.push(
        checkExtensionVersion(name, installedVersion, latestVersion),
      );
    }

    // 7. If --check, render and return
    if (options.check) {
      const result = buildUpdateResult(statuses);
      renderExtensionUpdateCheck(result, ctx.outputMode);
      return;
    }

    // 8. Perform updates for each update_available
    const finalStatuses: ExtensionUpdateStatus[] = [];
    for (const s of statuses) {
      if (s.status === "update_available") {
        renderExtensionUpdateProgress(
          s.name,
          s.installedVersion,
          s.latestVersion,
          ctx.outputMode,
        );

        const installCtx: InstallContext = {
          extensionClient,
          logger: ctx.logger,
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

        try {
          await installExtension(
            { name: s.name, version: s.latestVersion },
            installCtx,
          );

          finalStatuses.push({
            status: "updated",
            name: s.name,
            previousVersion: s.installedVersion,
            newVersion: s.latestVersion,
          });
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          finalStatuses.push({
            status: "failed",
            name: s.name,
            installedVersion: s.installedVersion,
            error: `Update failed: ${message}`,
          });
        }
      } else {
        finalStatuses.push(s);
      }
    }

    // 9. Render final results
    const result = buildUpdateResult(finalStatuses);
    renderExtensionUpdateResult(result, ctx.outputMode);
  });
