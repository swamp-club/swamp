// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  consumeStream,
  createLibSwampContext,
  modelOutputLogs,
} from "../../libswamp/mod.ts";
import { createModelOutputLogsRenderer } from "../../presentation/renderers/model_output_logs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputLogsCommand = new Command()
  .name("logs")
  .description("Show log artifact content for a model output")
  .arguments("<output_id:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--tail <n:number>", "Show only last N lines")
  .action(async function (options: AnyOptions, outputIdArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "logs",
    ]);
    cliCtx.logger.debug`Getting logs for output: ${outputIdArg}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const outputRepo = repoContext.outputRepo;
    const dataRepo = repoContext.unifiedDataRepo;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      isPartialId,
      matchOutputByPartialId: async (idPrefix: string) => {
        const allOutputs = await outputRepo.findAllGlobal();
        const result = matchByPartialId(
          allOutputs.map((o) => ({ id: o.output.id, item: o })),
          idPrefix,
        );
        if (result.status === "found") {
          return {
            status: "found" as const,
            match: { output: result.match.output, type: result.match.type },
          };
        }
        if (result.status === "ambiguous") {
          return {
            status: "ambiguous" as const,
            matches: result.matches.map((m) => ({ id: m.id })),
          };
        }
        return { status: "not_found" as const };
      },
      findDataByName: (
        type: ModelType,
        definitionId: string,
        name: string,
      ) => dataRepo.findByName(type, definitionId, name),
      getContent: (
        type: ModelType,
        definitionId: string,
        name: string,
      ) => dataRepo.getContent(type, definitionId, name),
    };

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
