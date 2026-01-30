import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { StreamingLogRepository } from "../../infrastructure/persistence/streaming_log_repository.ts";
import { createModelLogId } from "../../domain/models/model_log.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputLogsCommand = new Command()
  .name("logs")
  .description("Show log artifact content for a model output")
  .arguments("<output_id:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--tail <n:number>", "Show only last N lines")
  .action(async function (options: AnyOptions, outputIdArg: string) {
    const ctx = createContext(options as GlobalOptions, "model-output-logs");
    ctx.logger.debug`Getting logs for output: ${outputIdArg}`;

    const repoDir = options.repoDir ?? ".";
    const outputRepo = new YamlOutputRepository(repoDir);
    const logRepo = new StreamingLogRepository(repoDir);

    // Find the output using partial ID matching
    const allOutputs = await outputRepo.findAllGlobal();

    if (!isPartialId(outputIdArg)) {
      throw new UserError(
        `Invalid output ID format: ${outputIdArg}. ` +
          `Expected a UUID or partial ID (3+ hex characters).`,
      );
    }

    const result = matchByPartialId(
      allOutputs.map((o) => ({ id: o.output.id, item: o })),
      outputIdArg,
    );

    if (result.status === "not_found") {
      throw new UserError(`No output matches: ${outputIdArg}`);
    }

    if (result.status === "ambiguous") {
      throw new UserError(
        `Ambiguous ID prefix "${outputIdArg}" matches:\n` +
          result.matches.map((m) => `  ${m.id}`).join("\n"),
      );
    }

    const { output, type } = result.match;

    // Get log IDs from artifacts
    const logIds = output.artifacts?.logIds;
    if (!logIds || logIds.length === 0) {
      throw new UserError(
        `Output ${output.id} has no log artifacts. ` +
          `Status: ${output.status}, Method: ${output.methodName}`,
      );
    }

    // Fetch and display logs
    const allEntries: string[] = [];

    for (const logId of logIds) {
      const log = await logRepo.findById(type, createModelLogId(logId));
      if (log) {
        for (const entry of log.entries) {
          allEntries.push(entry.message);
        }
      }
    }

    // Apply --tail if specified
    const entriesToShow = options.tail
      ? allEntries.slice(-options.tail)
      : allEntries;

    if (ctx.outputMode === "json") {
      console.log(
        JSON.stringify(
          {
            outputId: output.id,
            methodName: output.methodName,
            logIds,
            lines: entriesToShow,
            totalLines: allEntries.length,
            showingLines: entriesToShow.length,
          },
          null,
          2,
        ),
      );
    } else {
      // Interactive: just print the logs directly
      for (const line of entriesToShow) {
        console.log(line);
      }
    }

    ctx.logger.debug("Model output logs command completed");
  });
