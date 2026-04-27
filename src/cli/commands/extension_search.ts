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
  interactiveOutputMode,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { UserError } from "../../domain/errors.ts";
import {
  ExtensionApiClient,
} from "../../infrastructure/http/extension_api_client.ts";
import { type PullContext, pullExtension } from "./extension_pull.ts";
import {
  consumeStream,
  createLibSwampContext,
  extensionSearch,
  type ExtensionSearchDeps,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import { createExtensionSearchRenderer } from "../../presentation/renderers/extension_search.tsx";
import { resolveSkillsDir } from "../../domain/repo/skill_dirs.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

/**
 * Resolves the registry server URL.
 * Priority: SWAMP_CLUB_URL env var > DEFAULT_SWAMP_CLUB_URL
 */
function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
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
    "Filter by content type (models, workflows, vaults, datastores, drivers, reports)",
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
      "reports",
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
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();

    ctx.logger.debug`Searching extensions with query: ${query ?? "(none)"}`;

    const deps: ExtensionSearchDeps = {
      searchExtensions: (params) =>
        client.searchExtensions({
          ...params,
          sort: params.sort as
            | "name"
            | "relevance"
            | "new"
            | "updated"
            | undefined,
        }),
    };

    const renderer = createExtensionSearchRenderer(effectiveMode);
    await consumeStream(
      extensionSearch(
        libCtx,
        deps,
        {
          query,
          collective: options.collective,
          platform: options.platform,
          label: options.label,
          contentType: options.contentType,
          sort: options.sort,
          perPage: options.perPage,
          page: options.page,
        },
      ),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();
    const action = renderer.selectedAction();

    if (selected && action === "install") {
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
      const absoluteModelsDir = resolve(repoDir, modelsDir);
      const lockfilePath = join(
        absoluteModelsDir,
        "upstream_extensions.json",
      );

      // Warn (don't block) on legacy layout. The pull that follows writes
      // to the per-extension subtree regardless of existing layout state.
      await warnLegacyExtensionLayout(
        lockfilePath,
        (msg) => ctx.logger.warn(msg),
      );

      const pullCtx: PullContext = {
        getExtension: (name) => client.getExtension(name),
        downloadArchive: (name, version) =>
          client.downloadArchive(name, version),
        getChecksum: (name, version) => client.getChecksum(name, version),
        logger: ctx.logger,
        lockfilePath,
        skillsDir: resolveSkillsDir(repoDir, marker?.tool ?? "claude"),
        repoDir,
        force: false,
        outputMode: ctx.outputMode,
        alreadyPulled: new Set(),
        depth: 0,
      };

      await pullExtension(
        { name: selected.name, version: null },
        pullCtx,
      );
    }
  });
