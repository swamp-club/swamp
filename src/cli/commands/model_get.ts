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
  definitionArgument,
  recordDefiningModule,
  withPreferredExample,
} from "./command_syntax.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelGetDeps,
  modelGet,
  type ModelGetData,
} from "../../libswamp/models/get.ts";
import {
  createModelGetRenderer,
  renderModelGet,
} from "../../presentation/renderers/model_get.ts";
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
import type { ModelGetResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** The preferred spelling: `swamp behavior get`. */
export const BEHAVIOR_GET_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior get",
  surface: "behavior",
};

/** The legacy spelling: `swamp model get`. */
export const MODEL_GET_SYNTAX: CommandSyntax = {
  invocation: "swamp model get",
  surface: "model",
  preferred: `${BEHAVIOR_GET_SYNTAX.invocation} my-server`,
};

export function createModelGetCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("get")
      .description(`Show details of a ${syntax.surface} definition`)
      .example(
        `Show ${syntax.surface} details`,
        `${syntax.invocation} my-server`,
      )
      .example("JSON output", `${syntax.invocation} my-server --json`)
      .arguments(`<${definitionArgument(syntax.surface)}:model_name>`)
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      ),
    syntax,
  )).action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (options: AnyOptions, modelIdOrName: string) {
      const cliCtx = createContext(options as GlobalOptions, ["model", "get"]);

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const token = await resolveServerTokenFromOptions(
          server,
          options,
        );
        const response = await requestServerResponse<ModelGetResponse>(
          { server, token },
          {
            type: "model.get",
            payload: { modelIdOrName },
          },
        );
        renderModelGet(
          response.data as unknown as ModelGetData,
          cliCtx.outputMode,
          syntax.surface,
        );
        return;
      }

      cliCtx.logger.debug`Getting model: ${modelIdOrName}`;

      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = await createModelGetDeps(repoContext.definitionRepo);

      const renderer = createModelGetRenderer(
        cliCtx.outputMode,
        syntax.surface,
      );
      await consumeStream(
        modelGet(ctx, deps, modelIdOrName),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Model get command completed");
    },
  );
  return recordDefiningModule(command, import.meta.url);
}

export const modelGetCommand = createModelGetCommand(MODEL_GET_SYNTAX);
