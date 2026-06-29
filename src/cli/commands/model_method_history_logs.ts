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
  createLibSwampContext,
  createModelMethodHistoryLogsDeps,
  type MethodHistoryLogsCompletedData,
  modelMethodHistoryLogs,
} from "../../libswamp/mod.ts";
import { createModelMethodHistoryLogsRenderer } from "../../presentation/renderers/model_method_history_logs.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelMethodHistoryLogsResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodHistoryLogsCommand = withRemoteOptions(
  new Command()
    .name("logs")
    .description("Show logs for a model method run")
    .example("Show run logs", "swamp model method history logs abc123")
    .example(
      "Tail last 50 lines",
      "swamp model method history logs abc123 --tail 50",
    )
    .arguments("<output_id_or_model_name:string>")
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option("--tail <lines:number>", "Show only the last N lines"),
).action(async function (options: AnyOptions, outputIdOrModelName: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "model",
    "method",
    "history",
    "logs",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerToken(
      server,
      options.token as string | undefined,
    );
    const response = await requestServerResponse<
      ModelMethodHistoryLogsResponse
    >(
      { server, token },
      {
        type: "model.method.history.logs",
        payload: {
          outputIdOrModelName,
          tail: options.tail as number | undefined,
        },
      },
    );
    const renderer = createModelMethodHistoryLogsRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response
            .data as unknown as MethodHistoryLogsCompletedData,
        };
      })(),
      renderer.handlers(),
    );
    return;
  }

  cliCtx.logger.debug`Getting logs for method run: ${outputIdOrModelName}`;

  const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
    {
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    },
  );

  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = await createModelMethodHistoryLogsDeps(
    repoDir,
    datastoreResolver,
  );

  const renderer = createModelMethodHistoryLogsRenderer(cliCtx.outputMode);
  await consumeStream(
    modelMethodHistoryLogs(ctx, deps, {
      outputIdOrModelName,
      tail: options.tail as number | undefined,
      repoDir,
    }),
    renderer.handlers(),
  );

  cliCtx.logger.debug("Model method history logs command completed");
});
