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
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelOutput } from "../../domain/models/model_output.ts";
import {
  readLogFile,
  renderLogFile,
} from "../../presentation/output/log_file_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodHistoryLogsCommand = new Command()
  .name("logs")
  .description("Show logs for a model method run")
  .arguments("<output_id_or_model_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--tail <lines:number>", "Show only the last N lines")
  .action(async function (options: AnyOptions, outputIdOrModelName: string) {
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "method",
      "history",
      "logs",
    ]);
    ctx.logger.debug`Getting logs for method run: ${outputIdOrModelName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const outputRepo = repoContext.outputRepo;

    let output: ModelOutput | undefined;

    if (isPartialId(outputIdOrModelName)) {
      // Try to find by output ID (partial or full)
      const allOutputs = await outputRepo.findAllGlobal();
      const matchResult = matchByPartialId(
        allOutputs.map((o) => ({ id: o.output.id, item: o })),
        outputIdOrModelName,
      );

      if (matchResult.status === "found") {
        output = matchResult.match.output;
      } else if (matchResult.status === "ambiguous") {
        throw new UserError(
          `Ambiguous ID prefix "${outputIdOrModelName}" matches:\n` +
            matchResult.matches.map((m) => `  ${m.id}`).join("\n"),
        );
      }
      // not_found: fall through to model name lookup
    }

    if (!output) {
      // Try as model name and get latest output
      const definitionResult = await findDefinitionByIdOrName(
        definitionRepo,
        outputIdOrModelName,
      );

      if (!definitionResult) {
        throw new UserError(
          `No method run or model found: ${outputIdOrModelName}`,
        );
      }

      const latestOutput = await outputRepo.findLatestByDefinition(
        definitionResult.type,
        definitionResult.definition.id,
      );
      if (!latestOutput) {
        throw new UserError(
          `No runs found for model: ${definitionResult.definition.name}`,
        );
      }

      output = latestOutput;
      ctx.logger
        .debug`Using latest run for model ${definitionResult.definition.name}: ${output.id}`;
    }

    // Read log file
    if (!output.logFile) {
      // Try to get model name for display
      let modelName = outputIdOrModelName;
      for (const modelType of modelRegistry.types()) {
        const definition = await definitionRepo.findById(
          modelType,
          output.definitionId,
        );
        if (definition) {
          modelName = definition.name;
          break;
        }
      }

      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(
          {
            outputId: output.id,
            modelName,
            methodName: output.methodName,
            error: "No log file recorded for this run (pre-logFile run)",
          },
          null,
          2,
        ));
      } else {
        console.log(
          `No log file recorded for run ${output.id.slice(0, 8)}. ` +
            `This run predates log file tracking.`,
        );
      }
      return;
    }

    const tail = options.tail as number | undefined;
    const logData = await readLogFile(output.logFile, { tail });

    if (logData.lines.length === 0) {
      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(
          {
            outputId: output.id,
            methodName: output.methodName,
            path: output.logFile,
            lines: [],
            lineCount: 0,
          },
          null,
          2,
        ));
      } else {
        console.log(`Log file not found or empty: ${output.logFile}`);
      }
      return;
    }

    renderLogFile(logData, ctx.outputMode);

    ctx.logger.debug("Model method history logs command completed");
  });
