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
  createModelOutputGetDeps,
  modelOutputGet,
  type ModelOutputGetData,
} from "../../libswamp/mod.ts";
import {
  createModelOutputGetRenderer,
  renderModelOutputGet,
} from "../../presentation/renderers/model_output_get.ts";
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
import type { ModelMethodHistoryGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function modelMethodHistoryGetAction(
  options: AnyOptions,
  outputIdOrModelName: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, [
    "model",
    "method",
    "history",
    "get",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<ModelMethodHistoryGetResponse>(
      { server, token },
      {
        type: "model.method.history.get",
        payload: { outputIdOrModelName },
      },
    );
    renderModelOutputGet(
      response.data as unknown as ModelOutputGetData,
      cliCtx.outputMode,
    );
    return;
  }

  cliCtx.logger.debug`Getting method run: ${outputIdOrModelName}`;

  const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
    {
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    },
  );

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = await createModelOutputGetDeps(repoDir, datastoreResolver);

  const renderer = createModelOutputGetRenderer(cliCtx.outputMode);
  await consumeStream(
    modelOutputGet(ctx, deps, outputIdOrModelName),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Model method history get command completed");
}

export const modelMethodHistoryGetCommand = withRemoteOptions(
  new Command()
    .name("get")
    .description("Show details of a model method run")
    .example("Show run details by ID", "swamp model method history get abc123")
    .example(
      "Show latest run for a model",
      "swamp model method history get my-server",
    )
    .arguments("<output_id_or_model_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    ),
).action(modelMethodHistoryGetAction);
