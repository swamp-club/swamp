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
  createWorkerQueueListDeps,
  withDefaults,
  workerQueueList,
  type WorkerQueueListData,
  type WorkerQueueListEvent,
} from "../../libswamp/mod.ts";
import { renderWorkerQueue } from "../../presentation/output/worker_output.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkerQueueListResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workerQueueCommand = withRemoteOptions(
  new Command()
    .name("queue")
    .description(
      "List steps currently queued for dispatch, waiting for a matching worker",
    )
    .example("List queued steps", "swamp worker queue")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "worker",
    "queue",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<WorkerQueueListResponse>(
      { server, token },
      {
        type: "worker.queue.list",
        payload: {},
      },
    );
    renderWorkerQueue(
      response.data as unknown as WorkerQueueListData,
      cliCtx.outputMode,
    );
    return;
  }

  const { repoContext } = await requireInitializedRepoReadOnly({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: cliCtx.outputMode,
  });

  const libCtx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = createWorkerQueueListDeps(repoContext.dataQueryService);

  await consumeStream(
    workerQueueList(libCtx, deps),
    withDefaults<WorkerQueueListEvent>({
      completed: (event) => {
        renderWorkerQueue(event.data, cliCtx.outputMode);
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );

  cliCtx.logger.debug("Worker queue command completed");
});
