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
  createModelOutputLogsDeps,
  modelOutputLogs,
  type ModelOutputLogsData,
} from "../../libswamp/models/output_logs.ts";
import { createModelOutputLogsRenderer } from "../../presentation/renderers/model_output_logs.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelOutputLogsResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** The preferred spelling: `swamp behavior output logs`. */
export const BEHAVIOR_OUTPUT_LOGS_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior output logs",
  surface: "behavior",
};

/** The legacy spelling: `swamp model output logs`. */
export const MODEL_OUTPUT_LOGS_SYNTAX: CommandSyntax = {
  invocation: "swamp model output logs",
  surface: "model",
  preferred: `${BEHAVIOR_OUTPUT_LOGS_SYNTAX.invocation} abc123`,
};

export function createModelOutputLogsCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("logs")
      .description(`Show log artifact content for a ${syntax.surface} output`)
      .example("Show output logs", `${syntax.invocation} abc123`)
      .example(
        "Tail last 100 lines",
        `${syntax.invocation} abc123 --tail 100`,
      )
      .arguments("<output_id:string>")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .option("--tail <n:number>", "Show only last N lines"),
    syntax,
  )).action(async function (options: AnyOptions, outputIdArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "logs",
    ]);

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );
      const response = await requestServerResponse<ModelOutputLogsResponse>(
        { server, token },
        {
          type: "model.output.logs",
          payload: {
            outputIdArg,
            tail: options.tail as number | undefined,
          },
        },
      );
      const renderer = createModelOutputLogsRenderer(cliCtx.outputMode);
      await consumeStream(
        (async function* () {
          yield {
            kind: "completed" as const,
            data: response.data as unknown as ModelOutputLogsData,
          };
        })(),
        renderer.handlers(),
      );
      return;
    }

    cliCtx.logger.debug`Getting logs for output: ${outputIdArg}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createModelOutputLogsDeps(repoDir, datastoreResolver);

    const renderer = createModelOutputLogsRenderer(cliCtx.outputMode);
    await consumeStream(
      modelOutputLogs(ctx, deps, {
        outputIdArg,
        tail: options.tail as number | undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model output logs command completed");
  });
  return recordDefiningModule(command, import.meta.url);
}

export const modelOutputLogsCommand = createModelOutputLogsCommand(
  MODEL_OUTPUT_LOGS_SYNTAX,
);
