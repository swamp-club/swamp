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
import { surfaceMethodNoun } from "../../presentation/command_surface.ts";
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
    const token = await resolveServerTokenFromOptions(
      server,
      options,
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

  const { repoDir, repoContext, datastoreResolver } =
    await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = await createModelOutputGetDeps(
    repoDir,
    datastoreResolver,
    repoContext.definitionRepo,
    repoContext.unreadableContent,
  );

  const renderer = createModelOutputGetRenderer(cliCtx.outputMode);
  await consumeStream(
    modelOutputGet(ctx, deps, outputIdOrModelName),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Model method history get command completed");
}

/** The preferred spelling: `swamp behavior history get`. */
export const BEHAVIOR_HISTORY_GET_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior history get",
  surface: "behavior",
};

/** The legacy spelling: `swamp model method history get`. */
export const MODEL_METHOD_HISTORY_GET_SYNTAX: CommandSyntax = {
  invocation: "swamp model method history get",
  surface: "model",
  preferred: `${BEHAVIOR_HISTORY_GET_SYNTAX.invocation} abc123`,
};

export function createModelMethodHistoryGetCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("get")
      .description(`Show details of a ${surfaceMethodNoun(syntax.surface)} run`)
      .example("Show run details by ID", `${syntax.invocation} abc123`)
      .example(
        `Show latest run for a ${syntax.surface}`,
        `${syntax.invocation} my-server`,
      )
      .arguments(`<${outputArgument(syntax.surface)}:string>`)
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      ),
    syntax,
  )).action(modelMethodHistoryGetAction);
  return recordDefiningModule(command, import.meta.url);
}

export const modelMethodHistoryGetCommand = createModelMethodHistoryGetCommand(
  MODEL_METHOD_HISTORY_GET_SYNTAX,
);
