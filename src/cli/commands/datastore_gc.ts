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
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { datastoreGc } from "../../libswamp/datastores/gc.ts";
import { createDatastoreGcRenderer } from "../../presentation/renderers/datastore_gc.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { runInCoordinatorRoot } from "../coordinator_root.ts";
import {
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const datastoreGcCommand = new Command()
  .name("gc")
  .description(
    "Delete content chunks no commit names any more (v3 datastores)",
  )
  .example("Collect unreferenced chunks", "swamp datastore gc")
  .example("Collect and output stats as JSON", "swamp datastore gc --json")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "gc",
    ]);

    // A writing command: on v3 it holds the datastore's writer lock, which
    // chunk GC needs (swamp-club#3279).
    const { repoDir, repoContext, datastoreResolver } =
      await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });
    const config = datastoreResolver.config();
    const v3 = resolverEngine(datastoreResolver) === "v3"
      ? v3DatastoreFor(repoDir, await v3DatastoreConfigOf(repoDir, config))
      : undefined;

    await runInCoordinatorRoot(repoContext, async () => {
      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const renderer = createDatastoreGcRenderer(cliCtx.outputMode);
      await consumeStream(
        datastoreGc(ctx, {
          ...(v3 !== undefined
            ? {
              collectChunks: async (signal: AbortSignal) => {
                const report = await v3.collectChunks(signal);
                return {
                  scanned: report.scanned,
                  referenced: report.referenced,
                  deleted: report.deleted,
                  restored: report.restored,
                  keptTooNew: report.keptTooNew,
                  keptOverBudget: report.keptOverBudget,
                  damaged: report.damaged.length,
                  tempFilesRemoved: report.tempFilesRemoved,
                };
              },
            }
            : {}),
        }),
        renderer.handlers(),
      );
    });
  });
