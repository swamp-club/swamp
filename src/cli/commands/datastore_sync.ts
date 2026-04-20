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
  consumeStream,
  createDatastoreSyncDeps,
  createLibSwampContext,
  datastoreSync,
} from "../../libswamp/mod.ts";
import { createDatastoreSyncRenderer } from "../../presentation/renderers/datastore_sync.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Manual sync command for S3 datastores.
 */
export const datastoreSyncCommand = new Command()
  .description("Sync local cache with S3 datastore")
  .example("Full sync", "swamp datastore sync")
  .example("Pull only", "swamp datastore sync --pull")
  .example("Push only", "swamp datastore sync --push")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--pull", "Pull-only mode (fetch all remote data to local cache)")
  .option("--push", "Push-only mode (upload all local cache data to S3)")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "sync",
    ]);
    cliCtx.logger.debug("Executing datastore sync command");

    const mode = options.push
      ? "push" as const
      : options.pull
      ? "pull" as const
      : "sync" as const;

    // Pull-only mode uses read-only init to avoid acquiring the global
    // lock and triggering a coordinator push on flush.
    const { repoDir, datastoreResolver } = mode === "pull"
      ? await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      })
      : await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createDatastoreSyncDeps(repoDir, datastoreResolver);
    const renderer = createDatastoreSyncRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreSync(ctx, deps, { mode }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Datastore sync command completed");
  });
