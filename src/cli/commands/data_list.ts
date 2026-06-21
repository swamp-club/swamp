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
import {
  consumeStream,
  createDataListDeps,
  createLibSwampContext,
  dataList,
  type DataListData,
} from "../../libswamp/mod.ts";
import { createDataListRenderer } from "../../presentation/renderers/data_list.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DataListResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataListCommand = withRemoteOptions(
  new Command()
    .name("list")
    .description("List all data for a model or workflow, grouped by type")
    .example("List all data for a model", "swamp data list my-server")
    .example("Filter by type", "swamp data list my-server --type output")
    .example("List workflow run data", "swamp data list --workflow deploy")
    .arguments("[model_id_or_name:model_name]")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--type <type:string>",
      "Filter by data type (log, file, resource, data)",
    )
    .option(
      "--workflow <name:string>",
      "List data produced by a workflow",
    )
    .option(
      "--run <run_id:string>",
      "Specific workflow run ID (defaults to latest)",
    ),
).action(
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  async function (options: AnyOptions, modelIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["data", "list"]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<DataListResponse>(
        { server, token },
        {
          type: "data.list",
          payload: {
            modelIdOrName,
            workflowName: options.workflow as string | undefined,
            runId: options.run as string | undefined,
            typeFilter: options.type as string | undefined,
          },
        },
      );
      const renderer = createDataListRenderer(cliCtx.outputMode, false);
      renderer.handlers().completed({
        kind: "completed",
        data: response.data as unknown as DataListData,
      });
      return;
    }

    const { repoDir, repoContext, datastoreResolver } =
      await requireInitializedRepoReadOnly(
        {
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        },
      );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const namespace = datastoreResolver.config().namespace;
    const deps = createDataListDeps(
      repoDir,
      datastoreResolver,
      repoContext.unifiedDataRepo,
      namespace,
      repoContext.workflowRepo,
    );

    const renderer = createDataListRenderer(cliCtx.outputMode, !!namespace);
    await consumeStream(
      dataList(ctx, deps, {
        modelIdOrName,
        workflowName: options.workflow as string | undefined,
        runId: options.run as string | undefined,
        typeFilter: options.type as string | undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Data list command completed");
  },
);
