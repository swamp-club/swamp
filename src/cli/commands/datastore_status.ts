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
  createDatastoreStatusDeps,
  createLibSwampContext,
  datastoreStatus,
} from "../../libswamp/mod.ts";
import { createDatastoreStatusRenderer } from "../../presentation/renderers/datastore_status.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Shows current datastore configuration and health.
 */
export const datastoreStatusCommand = new Command()
  .description("Show datastore configuration and health")
  .example("Show datastore health", "swamp datastore status")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "status",
    ]);
    cliCtx.logger.debug("Executing datastore status command");

    const { datastoreResolver } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createDatastoreStatusDeps(datastoreResolver);
    const renderer = createDatastoreStatusRenderer(cliCtx.outputMode);
    await consumeStream(datastoreStatus(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Datastore status command completed");
  });
