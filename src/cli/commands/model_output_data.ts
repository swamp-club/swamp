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
  recordDefiningModule,
  withPreferredExample,
} from "./command_syntax.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelOutputDataDeps,
  modelOutputData,
  type ModelOutputDataData,
} from "../../libswamp/models/output_data.ts";
import { createModelOutputDataRenderer } from "../../presentation/renderers/model_output_data.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelOutputDataResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** The preferred spelling: `swamp behavior output data`. */
export const BEHAVIOR_OUTPUT_DATA_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior output data",
  surface: "behavior",
};

/** The legacy spelling: `swamp model output data`. */
export const MODEL_OUTPUT_DATA_SYNTAX: CommandSyntax = {
  invocation: "swamp model output data",
  surface: "model",
  preferred: `${BEHAVIOR_OUTPUT_DATA_SYNTAX.invocation} abc123`,
};

export function createModelOutputDataCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("data")
      .description(`Show data artifact content for a ${syntax.surface} output`)
      .example("Show output data", `${syntax.invocation} abc123`)
      .example(
        "Show specific field",
        `${syntax.invocation} abc123 --field status`,
      )
      .example(
        "Show specific version",
        `${syntax.invocation} abc123 --version 2`,
      )
      .arguments("<output_id:string>")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .option(
        "--field <name:string>",
        "Show only a specific field from the data",
      )
      .option(
        "--version <version:number>",
        "Specific data version (defaults to artifact version)",
      )
      .option(
        "--name <name:string>",
        "Data name to retrieve (if output has multiple artifacts)",
      ),
    syntax,
  )).action(async function (options: AnyOptions, outputIdArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "data",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const response = await requestServerResponse<ModelOutputDataResponse>(
        { server, token },
        {
          type: "model.output.data",
          payload: {
            outputIdArg,
            name: options.name as string | undefined,
            field: options.field as string | undefined,
            version: options.version as number | undefined,
          },
        },
      );
      const renderer = createModelOutputDataRenderer(cliCtx.outputMode);
      await consumeStream(
        (async function* () {
          yield {
            kind: "completed" as const,
            data: response.data as unknown as ModelOutputDataData,
          };
        })(),
        renderer.handlers(),
      );
      return;
    }

    cliCtx.logger.debug`Getting data for output: ${outputIdArg}`;

    const { repoDir, repoContext, datastoreResolver } =
      await requireInitializedRepoReadOnly(
        {
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        },
      );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createModelOutputDataDeps(
      repoDir,
      datastoreResolver,
      undefined,
      repoContext.definitionRepo,
      repoContext.unreadableContent,
    );

    const renderer = createModelOutputDataRenderer(cliCtx.outputMode);
    await consumeStream(
      modelOutputData(ctx, deps, {
        outputIdArg,
        name: options.name as string | undefined,
        field: options.field as string | undefined,
        version: options.version as number | undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model output data command completed");
  });
  return recordDefiningModule(command, import.meta.url);
}

export const modelOutputDataCommand = createModelOutputDataCommand(
  MODEL_OUTPUT_DATA_SYNTAX,
);
