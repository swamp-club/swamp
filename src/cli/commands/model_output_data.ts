import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlDataRepository } from "../../infrastructure/persistence/yaml_data_repository.ts";
import { createModelDataId } from "../../domain/models/model_data.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputDataCommand = new Command()
  .name("data")
  .description("Show data artifact content for a model output")
  .arguments("<output_id:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--field <name:string>", "Show only a specific field from the data")
  .action(async function (options: AnyOptions, outputIdArg: string) {
    const ctx = createContext(options as GlobalOptions, "model-output-data");
    ctx.logger.debug`Getting data for output: ${outputIdArg}`;

    const repoDir = options.repoDir ?? ".";
    const outputRepo = new YamlOutputRepository(repoDir);
    const dataRepo = new YamlDataRepository(repoDir);

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

    // Get data ID from artifacts
    const dataId = output.artifacts?.dataId;
    if (!dataId) {
      throw new UserError(
        `Output ${output.id} has no data artifact. ` +
          `Status: ${output.status}, Method: ${output.methodName}`,
      );
    }

    // Fetch the data artifact
    const data = await dataRepo.findById(type, createModelDataId(dataId));
    if (!data) {
      throw new UserError(
        `Data artifact ${dataId} not found for output ${output.id}`,
      );
    }

    // Get the attributes to display
    let displayData: unknown = data.attributes;

    // If a specific field is requested, extract it
    if (options.field) {
      const fieldValue = data.attributes[options.field];
      if (fieldValue === undefined) {
        const availableFields = Object.keys(data.attributes).join(", ");
        throw new UserError(
          `Field "${options.field}" not found in data artifact. ` +
            `Available fields: ${availableFields || "(none)"}`,
        );
      }
      displayData = fieldValue;
    }

    if (ctx.outputMode === "json") {
      console.log(
        JSON.stringify(
          {
            outputId: output.id,
            methodName: output.methodName,
            dataId,
            field: options.field ?? null,
            data: displayData,
          },
          null,
          2,
        ),
      );
    } else {
      // Interactive: print the data in a readable format
      if (typeof displayData === "string") {
        console.log(displayData);
      } else {
        console.log(JSON.stringify(displayData, null, 2));
      }
    }

    ctx.logger.debug("Model output data command completed");
  });
