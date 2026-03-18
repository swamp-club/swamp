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
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { readLogFile } from "../../presentation/output/log_file_reader.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import {
  consumeStream,
  createLibSwampContext,
  modelMethodHistoryLogs,
} from "../../libswamp/mod.ts";
import { createModelMethodHistoryLogsRenderer } from "../../presentation/renderers/model_method_history_logs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodHistoryLogsCommand = new Command()
  .name("logs")
  .description("Show logs for a model method run")
  .arguments("<output_id_or_model_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--tail <lines:number>", "Show only the last N lines")
  .action(async function (options: AnyOptions, outputIdOrModelName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "method",
      "history",
      "logs",
    ]);
    cliCtx.logger.debug`Getting logs for method run: ${outputIdOrModelName}`;

    const { repoDir, repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const outputRepo = repoContext.outputRepo;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      isPartialId,
      matchOutputByPartialId: async (idPrefix: string) => {
        const allOutputs = await outputRepo.findAllGlobal();
        const result = matchByPartialId(
          allOutputs.map((o) => ({ id: o.output.id, item: o.output })),
          idPrefix,
        );
        if (result.status === "found") {
          return { status: "found" as const, match: result.match };
        }
        if (result.status === "ambiguous") {
          return {
            status: "ambiguous" as const,
            matches: result.matches.map((m) => ({ id: m.id })),
          };
        }
        return { status: "not_found" as const };
      },
      findDefinition: (idOrName: string) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
      findLatestOutput: (
        type: ModelType,
        definitionId: string,
      ) =>
        outputRepo.findLatestByDefinition(
          type,
          definitionId as DefinitionId,
        ),
      getModelName: async (definitionId: string) => {
        for (const modelType of modelRegistry.types()) {
          const definition = await definitionRepo.findById(
            modelType,
            definitionId as DefinitionId,
          );
          if (definition) {
            return definition.name;
          }
        }
        return outputIdOrModelName;
      },
      readLogFile,
      toRelativePath,
    };

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
