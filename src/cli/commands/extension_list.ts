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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { join, resolve } from "@std/path";
import {
  createExtensionListDeps,
  createLibSwampContext,
  extensionList,
  type ExtensionListEntry,
  result,
  warnLegacyExtensionLayout,
} from "../../libswamp/mod.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  createExtensionListRenderer,
  type EnrichedExtensionListEntry,
} from "../../presentation/renderers/extension_list.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { loadIdentity } from "../load_identity.ts";
import { FileExtensionUpdateCheckRepository } from "../../infrastructure/persistence/extension_update_check_repository.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import {
  DEFAULT_FRESHNESS_CONCURRENCY,
  enrichExtensionList,
  type ExtensionListFreshnessDeps,
} from "./extension_list_freshness.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/**
 * Decides whether to run the freshness composer for `extension list`.
 * TTY-aware default: enabled when stdout is a terminal AND output mode
 * is "log". Explicit overrides win in either direction.
 */
export function shouldEnrich(args: {
  checkUpdates: boolean | undefined;
  outputMode: "log" | "json";
  isTerminal: () => boolean;
}): boolean {
  if (args.checkUpdates === true) return true;
  if (args.checkUpdates === false) return false;
  if (args.outputMode === "json") return false;
  return args.isTerminal();
}

export const extensionListCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List upstream installed extensions")
  .example("List installed extensions", "swamp extension list")
  .example(
    "List with freshness check (force on)",
    "swamp extension list --check-updates",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--check-updates",
    "Check the registry for newer versions and show a 'latest' column. " +
      "Runs by default when stdout is a terminal; pass this flag to force on " +
      "(e.g. when using --json in CI).",
    { conflicts: ["no-check-updates"] },
  )
  .option(
    "--no-check-updates",
    "Skip the registry check for newer versions, showing only installed data.",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "list",
    ]);
    cliCtx.logger.debug`Starting extension list`;

    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    // Warn (don't block) if any extensions are still in a legacy layout.
    // list reads the lockfile, which tolerates mixed-generation state.
    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
    await warnLegacyExtensionLayout(
      lockfilePath,
      (msg) => cliCtx.logger.warn(msg),
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createExtensionListDeps(repoDir);

    // Pull the bare list from the libswamp generator (pure local read).
    const completed = await result(extensionList(ctx, deps));
    const baseEntries: ExtensionListEntry[] = completed.data.extensions;

    // Decide whether to enrich based on TTY-aware default + explicit flags.
    const enrich = shouldEnrich({
      checkUpdates: options.checkUpdates as boolean | undefined,
      outputMode: cliCtx.outputMode,
      isTerminal: () => Deno.stdout.isTerminal(),
    });

    let enrichedEntries: EnrichedExtensionListEntry[];
    if (enrich && baseEntries.length > 0) {
      const swampDir = join(resolve(repoDir), ".swamp");
      const cacheRepository = new FileExtensionUpdateCheckRepository(swampDir);
      const identity = await loadIdentity();
      const apiClient = new ExtensionApiClient(resolveServerUrl(), identity);
      const freshnessDeps: ExtensionListFreshnessDeps = {
        getLatestVersion: async (name) => {
          try {
            const info = await apiClient.getExtension(name);
            return info?.latestVersion ?? null;
          } catch {
            return null;
          }
        },
        cacheRepository,
        now: () => new Date(),
        concurrency: DEFAULT_FRESHNESS_CONCURRENCY,
      };
      try {
        enrichedEntries = await enrichExtensionList(
          baseEntries,
          freshnessDeps,
        );
      } catch (error) {
        // Degrade to the bare list on any unexpected failure. Mirrors
        // the swallow-and-degrade pattern used by
        // checkForMissingPulledExtensions in cli/mod.ts.
        cliCtx.logger.debug(
          "Extension freshness enrichment failed; falling back to bare list: {error}",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        enrichedEntries = baseEntries;
      }
    } else {
      enrichedEntries = baseEntries;
    }

    const verbose = cliCtx.verbosity === "verbose";
    const renderer = createExtensionListRenderer(cliCtx.outputMode, verbose);
    await renderer.handlers().resolving({ kind: "resolving" });
    await renderer.handlers().completed({
      kind: "completed",
      data: { extensions: enrichedEntries },
    });

    cliCtx.logger.debug("Extension list command completed");
  });
