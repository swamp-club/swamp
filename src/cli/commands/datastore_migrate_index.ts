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
  consumeStream,
  createLibSwampContext,
  createMigrateIndexDeps,
  datastoreMigrateIndex,
} from "../../libswamp/mod.ts";
import { createDatastoreMigrateIndexRenderer } from "../../presentation/renderers/datastore_migrate_index.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const datastoreMigrateIndexCommand = new Command()
  .name("migrate-index")
  .description(
    "Migrate the datastore index from monolithic to shard-first format",
  )
  .example(
    "Migrate the index",
    "swamp datastore migrate-index",
  )
  .example(
    "Migrate and output result as JSON",
    "swamp datastore migrate-index --json",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "migrate-index",
    ]);
    cliCtx.logger.debug("Executing datastore migrate-index command");

    const { repoDir, datastoreResolver } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
      skipImplicitSync: true,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createMigrateIndexDeps(repoDir, datastoreResolver);
    const renderer = createDatastoreMigrateIndexRenderer(cliCtx.outputMode);
    await consumeStream(
      datastoreMigrateIndex(ctx, deps),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Datastore migrate-index command completed");
  });
