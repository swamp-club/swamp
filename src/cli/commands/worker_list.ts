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
import { UserError } from "../../domain/errors.ts";
import {
  consumeStream,
  createLibSwampContext,
  createWorkerListDeps,
  withDefaults,
  workerList,
  type WorkerListEvent,
} from "../../libswamp/mod.ts";
import { renderWorkerList } from "../../presentation/output/worker_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerListCommand = new Command()
  .name("list")
  .description(
    "List workers in the pool: status, labels, platform, and last seen",
  )
  .example("List all workers", "swamp worker list")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "worker",
      "list",
    ]);

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkerListDeps(repoContext.dataQueryService);

    await consumeStream(
      workerList(libCtx, deps),
      withDefaults<WorkerListEvent>({
        completed: (event) => {
          renderWorkerList(event.data, cliCtx.outputMode);
        },
        error: (event) => {
          throw new UserError(event.error.message);
        },
      }),
    );

    cliCtx.logger.debug("Worker list command completed");
  });
