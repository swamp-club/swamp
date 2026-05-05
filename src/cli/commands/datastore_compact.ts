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
  createLibSwampContext,
  datastoreCompact,
  type DatastoreCompactDeps,
} from "../../libswamp/mod.ts";
import { createDatastoreCompactRenderer } from "../../presentation/renderers/datastore_compact.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { join } from "@std/path";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const datastoreCompactCommand = new Command()
  .name("compact")
  .description(
    "Checkpoint the WAL and vacuum the catalog database to reclaim disk space",
  )
  .example(
    "Compact the catalog database",
    "swamp datastore compact",
  )
  .example(
    "Compact and output stats as JSON",
    "swamp datastore compact --json",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "compact",
    ]);

    const { repoDir, datastoreResolver } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const catalogStore = createCatalogStore(repoDir, datastoreResolver);
    const dataBaseDir = datastoreResolver?.resolvePath(SWAMP_SUBDIRS.data) ??
      swampPath(repoDir, SWAMP_SUBDIRS.data);
    const catalogDbPath = join(dataBaseDir, "_catalog.db");

    const deps: DatastoreCompactDeps = {
      checkpoint: () => catalogStore.checkpoint(),
      vacuum: () => catalogStore.vacuum(),
      catalogDbSize: async () => {
        try {
          const stat = await Deno.stat(catalogDbPath);
          return stat.size;
        } catch {
          return 0;
        }
      },
    };

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const renderer = createDatastoreCompactRenderer(cliCtx.outputMode);
    await consumeStream(datastoreCompact(ctx, deps), renderer.handlers());
    catalogStore.close();
  });
