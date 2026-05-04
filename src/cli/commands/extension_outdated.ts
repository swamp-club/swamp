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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  createExtensionUpdateDeps,
  createLibSwampContext,
  extensionUpdate,
  result,
} from "../../libswamp/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import type { ExtensionUpdateStatus } from "../../domain/extensions/extension_update_service.ts";
import { createExtensionOutdatedRenderer } from "../../presentation/renderers/extension_outdated.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/**
 * Filter a status array down to "outdated" rows: anything that is not
 * up_to_date is rendered (so users see not_found and failed too), but
 * the exit code only fails on update_available — see
 * `hasUpdateAvailable` in the renderer payload.
 */
export function filterOutdated(
  statuses: ExtensionUpdateStatus[],
): ExtensionUpdateStatus[] {
  return statuses.filter((s) =>
    s.status === "update_available" ||
    s.status === "not_found" ||
    s.status === "failed"
  );
}

/**
 * `swamp extension outdated`
 *
 * Wraps the existing extensionUpdate generator with checkOnly=true,
 * filters out up_to_date entries for display, and exits with code 1
 * if and only if at least one extension has status update_available.
 * not_found and failed statuses are rendered inline as informational
 * but do NOT fail the exit code (CI gate `swamp extension outdated &&
 * deploy` should fail only on a clear newer-version-exists signal,
 * not on transient registry errors).
 *
 * Note on concurrency: this command wraps the existing
 * libswamp/extensions/update.ts:extensionUpdate generator which
 * iterates installed extensions sequentially (loop at line 133).
 * `swamp extension list --check-updates` uses a parallel composer
 * (concurrency=4); the inconsistency is intentional. `outdated`
 * mirrors `extension update --check` so the two behave identically;
 * making them diverge would surprise users of `update --check`.
 */
export const extensionOutdatedCommand = new Command()
  .name("outdated")
  .description(
    "List installed extensions with newer versions available. " +
      "Exits 1 if any update is available (suitable for CI gates).",
  )
  .example("Check for updates", "swamp extension outdated")
  .example(
    "Use as a CI gate",
    "swamp extension outdated && deploy",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "outdated",
    ]);
    cliCtx.logger.debug`Starting extension outdated`;

    const repoDir = resolveRepoDir(options.repoDir);
    await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(repoPath);
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createExtensionUpdateDeps({
      lockfilePath,
      serverUrl: resolveServerUrl(),
      // outdated is read-only — installation is wired but never invoked
      // because checkOnly=true short-circuits before any update path.
      installExtension: () => {
        throw new Error(
          "installExtension should not be called in checkOnly mode",
        );
      },
    });

    const completed = await result(
      extensionUpdate(ctx, deps, { checkOnly: true }),
    );

    const filtered = filterOutdated(completed.data.extensions);
    const hasUpdateAvailable = filtered.some(
      (s) => s.status === "update_available",
    );

    const renderer = createExtensionOutdatedRenderer(cliCtx.outputMode);
    await renderer.handlers().completed({
      kind: "completed",
      data: { extensions: filtered, hasUpdateAvailable },
    });

    cliCtx.logger.debug("Extension outdated command completed");

    if (hasUpdateAvailable) {
      Deno.exit(1);
    }
  });
