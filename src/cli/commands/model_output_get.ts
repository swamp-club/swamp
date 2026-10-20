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
  type CommandSyntax,
  outputArgument,
  recordDefiningModule,
  withPreferredExample,
} from "./command_syntax.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelOutputGetDeps,
  modelOutputGet,
  type ModelOutputGetData,
} from "../../libswamp/models/output_get.ts";
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
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelOutputGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function modelOutputGetAction(
  options: AnyOptions,
  outputIdOrModelName: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, [
    "model",
    "output",
    "get",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<ModelOutputGetResponse>(
      { server, token },
      {
        type: "model.output.get",
        payload: { outputIdOrModelName },
      },
    );
    renderModelOutputGet(
      response.data as unknown as ModelOutputGetData,
      cliCtx.outputMode,
    );
    return;
  }

  cliCtx.logger.debug`Getting output: ${outputIdOrModelName}`;

  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = {
    ...await createModelOutputGetDeps(
      repoDir,
      datastoreResolver,
      repoContext.definitionRepo,
      repoContext.unreadableContent,
    ),
    retentionWatermarks: repoContext.retentionWatermarks,
  };

  const renderer = createModelOutputGetRenderer(cliCtx.outputMode);
  await consumeStream(
    modelOutputGet(ctx, deps, outputIdOrModelName),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Model output get command completed");
}

/** The preferred spelling: `swamp behavior output get`. */
export const BEHAVIOR_OUTPUT_GET_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior output get",
  surface: "behavior",
};

/** The legacy spelling: `swamp model output get`. */
export const MODEL_OUTPUT_GET_SYNTAX: CommandSyntax = {
  invocation: "swamp model output get",
  surface: "model",
  preferred: `${BEHAVIOR_OUTPUT_GET_SYNTAX.invocation} abc123`,
};

export function createModelOutputGetCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("get")
      .description(`Show details of a ${syntax.surface} output`)
      .example("Show output details by ID", `${syntax.invocation} abc123`)
      .example(
        `Show latest output for a ${syntax.surface}`,
        `${syntax.invocation} my-server`,
      )
      .arguments(`<${outputArgument(syntax.surface)}:string>`)
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      ),
    syntax,
  )).action(modelOutputGetAction);
  return recordDefiningModule(command, import.meta.url);
}

export const modelOutputGetCommand = createModelOutputGetCommand(
  MODEL_OUTPUT_GET_SYNTAX,
);
