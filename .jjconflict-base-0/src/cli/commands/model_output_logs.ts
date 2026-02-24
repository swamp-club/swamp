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
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "logs",
    ]);
    ctx.logger.debug`Getting logs for output: ${outputIdArg}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const outputRepo = repoContext.outputRepo;
    const dataRepo = repoContext.unifiedDataRepo;

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

    // Get log IDs from artifacts (find all artifacts with type "log")
    const logArtifacts = output.artifacts.dataArtifacts.filter(
      (a) => a.tags.type === "log",
    );
    if (logArtifacts.length === 0) {
      throw new UserError(
        `Output ${output.id} has no log artifacts. ` +
          `Status: ${output.status}, Method: ${output.methodName}`,
      );
    }

    // Fetch and display logs from unified data repository
    const allEntries: string[] = [];

    for (const artifact of logArtifacts) {
      // Log data is stored with the artifact name in the unified data repository
      // findByName without a version returns the latest version
      const dataResult = await dataRepo.findByName(
        type,
        output.definitionId,
        artifact.name,
      );
      if (dataResult) {
        // Read the log content (without version argument to get latest)
        const content = await dataRepo.getContent(
          type,
          output.definitionId,
          artifact.name,
        );
        if (content) {
          const text = new TextDecoder().decode(content);
          // Split into lines
          const lines = text.split("\n").filter((line) => line.length > 0);
          allEntries.push(...lines);
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
            logArtifacts: logArtifacts.map((a) => a.name),
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
