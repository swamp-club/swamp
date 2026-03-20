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
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
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
import {
  ExtensionApiClient,
  type ExtensionSearchParams,
} from "../../infrastructure/http/extension_api_client.ts";
import { type PullContext, pullExtension } from "./extension_pull.ts";
import { renderExtensionSearch } from "../../presentation/output/extension_search_output.tsx";

const DEFAULT_SERVER_URL = "https://swamp.club";

/**
 * Resolves the registry server URL.
 * Priority: SWAMP_CLUB_URL env var > default "https://swamp.club"
 */
function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionSearchCommand = new Command()
  .name("search")
  .description("Search the swamp extension registry")
  .arguments("[query:string]")
  .option("--collective <collective:string>", "Filter by collective")
  .option("--platform <platform:string>", "Filter by platform", {
    collect: true,
  })
  .option("--label <label:string>", "Filter by label", { collect: true })
  .option(
    "--content-type <contentType:string>",
    "Filter by content type (models, workflows, vaults, datastores, drivers)",
    { collect: true },
  )
  .option(
    "--sort <sort:string>",
    "Sort order: relevance, new, updated, name",
  )
  .option("--per-page <perPage:number>", "Results per page", { default: 20 })
  .option("--page <page:number>", "Page number", { default: 1 })
  .example("Browse all extensions", "swamp extension search")
  .example("Search by keyword", "swamp extension search aws")
  .example(
    "Filter by collective",
    "swamp extension search --collective stack72",
  )
  .example(
    "Filter by platform and label",
    "swamp extension search --platform aws --label networking",
  )
  .example(
    "Filter by content type",
    "swamp extension search --content-type models",
  )
  .example(
    "Sort by newest",
    "swamp extension search --sort new",
  )
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "extension",
      "search",
    ]);

    // Validate sort + query combination
    if (options.sort === "relevance" && !query) {
      throw new UserError(
        'Sort by "relevance" requires a search query.',
      );
    }

    // Validate content type values
    const validContentTypes = [
      "models",
      "workflows",
      "vaults",
      "datastores",
      "drivers",
    ];
    for (const ct of options.contentType ?? []) {
      if (!validContentTypes.includes(ct)) {
        throw new UserError(
          `Invalid content type: "${ct}". Must be one of: ${
            validContentTypes.join(", ")
          }`,
        );
      }
    }

    // Validate sort option value
    const validSorts = ["relevance", "new", "updated", "name"];
    if (options.sort && !validSorts.includes(options.sort)) {
      throw new UserError(
        `Invalid sort option: "${options.sort}". Must be one of: ${
          validSorts.join(", ")
        }`,
      );
    }

    const serverUrl = resolveServerUrl();
    const client = new ExtensionApiClient(serverUrl);

    const params: ExtensionSearchParams = {
      q: query,
      collective: options.collective,
      platform: options.platform,
      label: options.label,
      contentType: options.contentType,
      sort: options.sort,
      perPage: options.perPage,
      page: options.page,
    };

    ctx.logger.debug`Searching extensions with params: ${
      JSON.stringify(params)
    }`;

    const response = await client.searchExtensions(params);

    const effectiveMode = interactiveOutputMode(ctx);
    const result = await renderExtensionSearch(
      {
        extensions: response.extensions.map((ext) => ({
          name: ext.name,
          description: ext.description,
          latestVersion: ext.latestVersion,
          platforms: ext.platforms,
          labels: ext.labels,
          contentTypes: ext.contentTypes ?? [],
          createdAt: ext.createdAt,
          updatedAt: ext.updatedAt,
        })),
        meta: response.meta,
      },
      effectiveMode,
    );

    if (result?.action === "install") {
      // Install writes files to the repo, so acquire the datastore lock
      const repoDir = ".";
      await requireInitializedRepo({
        repoDir,
        outputMode: ctx.outputMode,
      });

      const repoPath = RepoPath.create(repoDir);
      const markerRepo = new RepoMarkerRepository();
      const marker = await markerRepo.read(repoPath);
      const modelsDir = resolveModelsDir(marker);
      const workflowsDir = resolveWorkflowsDir(marker);
      const vaultsDir = resolveVaultsDir(marker);
      const driversDir = resolveDriversDir(marker);
      const datastoresDir = resolveDatastoresDir(marker);
      const reportsDir = resolveReportsDir(marker);

      const pullCtx: PullContext = {
        extensionClient: client,
        logger: ctx.logger,
        modelsDir,
        workflowsDir,
        vaultsDir,
        driversDir,
        datastoresDir,
        reportsDir,
        repoDir,
        force: false,
        outputMode: ctx.outputMode,
        alreadyPulled: new Set(),
        depth: 0,
      };

      await pullExtension(
        { name: result.extension.name, version: null },
        pullCtx,
      );
    }
  });
