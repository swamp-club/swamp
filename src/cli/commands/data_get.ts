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
  createDataGetDeps,
  createLibSwampContext,
  dataGet,
  type DataGetData,
} from "../../libswamp/mod.ts";
import {
  createDataGetRenderer,
  renderDataGet,
} from "../../presentation/renderers/data_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DataGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description("Get data by model and name, or by workflow")
    .example("Get latest data", "swamp data get my-server system-info")
    .example(
      "Get a specific version",
      "swamp data get my-server system-info --version 2",
    )
    .example(
      "Get workflow data",
      "swamp data get --workflow deploy --run latest",
    )
    .example(
      "Metadata only",
      "swamp data get my-server system-info --no-content",
    )
    .example(
      "From a remote server",
      "swamp data get my-server system-info --server wss://demo.swamp-club.ai",
    )
    .arguments("[model_id_or_name:model_name] [data_name:string]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--version <version:number>",
      "Specific version (defaults to latest)",
    )
    .option(
      "--workflow <name:string>",
      "Get data produced by a workflow",
    )
    .option(
      "--run <run_id:string>",
      "Specific workflow run ID (defaults to latest)",
    )
    .option(
      "--no-content",
      "Show metadata only, without content",
    ),
).action(
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  async function (
    options: AnyOptions,
    modelIdOrName?: string,
    dataName?: string,
  ) {
    const cliCtx = createContext(options as GlobalOptions, ["data", "get"]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<DataGetResponse>(
        { server, token },
        {
          type: "data.get",
          payload: {
            modelIdOrName,
            dataName,
            workflowName: options.workflow as string | undefined,
            runId: options.run as string | undefined,
            version: options.version as number | undefined,
            includeContent: options.content !== false,
          },
        },
      );
      renderDataGet(response.data as unknown as DataGetData, cliCtx.outputMode);
      return;
    }

    const { repoDir, repoContext, datastoreResolver } =
      await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createDataGetDeps(
      repoDir,
      datastoreResolver,
      repoContext.unifiedDataRepo,
      repoContext.workflowRepo,
    );

    const renderer = createDataGetRenderer(cliCtx.outputMode);
    await consumeStream(
      dataGet(ctx, deps, {
        modelIdOrName,
        dataName,
        workflowName: options.workflow as string | undefined,
        runId: options.run as string | undefined,
        version: options.version as number | undefined,
        includeContent: options.content !== false,
        repoDir,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Data get command completed");
  },
);
