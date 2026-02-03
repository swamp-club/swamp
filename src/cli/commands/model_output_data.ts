import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import {
  createDefinitionId,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputDataCommand = new Command()
  .name("data")
  .description("Show data artifact content for a model output")
  .arguments("<output_id:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--field <name:string>", "Show only a specific field from the data")
  .option(
    "--version <version:number>",
    "Specific data version (defaults to artifact version)",
  )
  .option(
    "--name <name:string>",
    "Data name to retrieve (if output has multiple artifacts)",
  )
  .action(async function (options: AnyOptions, outputIdArg: string) {
    const ctx = createContext(options as GlobalOptions, "model-output-data");
    ctx.logger.debug`Getting data for output: ${outputIdArg}`;

    const repoDir = options.repoDir ?? ".";
    const outputRepo = new YamlOutputRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);

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

    // Find the data artifact - either by name if specified, or first with type "data"
    let dataArtifact;
    if (options.name) {
      dataArtifact = output.artifacts.dataArtifacts.find(
        (a) => a.name === options.name,
      );
      if (!dataArtifact) {
        const availableNames = output.artifacts.dataArtifacts
          .map((a) => a.name)
          .join(", ");
        throw new UserError(
          `Data artifact "${options.name}" not found. ` +
            `Available: ${availableNames || "(none)"}`,
        );
      }
    } else {
      // Default to first data artifact with type "data", or just first artifact
      dataArtifact = output.artifacts.dataArtifacts.find(
        (a) => a.tags.type === "data",
      ) ?? output.artifacts.dataArtifacts[0];
    }

    if (!dataArtifact) {
      throw new UserError(
        `Output ${output.id} has no data artifacts. ` +
          `Status: ${output.status}, Method: ${output.methodName}`,
      );
    }

    // Get the definition to find model ID
    const definitionId = createDefinitionId(
      output.definitionId,
    ) as DefinitionId;
    const definition = await definitionRepo.findById(type, definitionId);
    if (!definition) {
      throw new UserError(
        `Definition ${output.definitionId} not found for output ${output.id}`,
      );
    }

    // Get the version (from option, artifact, or latest)
    const version = options.version as number | undefined ??
      dataArtifact.version;

    // Find the data using the unified repository
    const data = await dataRepo.findByName(
      type,
      definition.id,
      dataArtifact.name,
      version,
    );

    if (!data) {
      throw new UserError(
        `Data "${dataArtifact.name}" (v${version}) not found for model "${definition.name}"`,
      );
    }

    // Get the raw content
    const content = await dataRepo.getContent(
      type,
      definition.id,
      dataArtifact.name,
      version,
    );

    if (!content) {
      throw new UserError(
        `Data content not found for "${dataArtifact.name}" (v${version})`,
      );
    }

    // Try to parse as JSON if content type is JSON
    let displayData: unknown;
    const isJson = data.contentType === "application/json";

    if (isJson) {
      try {
        const text = new TextDecoder().decode(content);
        displayData = JSON.parse(text);
      } catch {
        // Not valid JSON despite content type, show as text
        displayData = new TextDecoder().decode(content);
      }
    } else {
      // Non-JSON content, decode as text
      displayData = new TextDecoder().decode(content);
    }

    // If a specific field is requested, extract it (only works for JSON)
    if (options.field) {
      if (typeof displayData !== "object" || displayData === null) {
        throw new UserError(
          `Cannot extract field "${options.field}": data is not a JSON object`,
        );
      }
      const fieldValue =
        (displayData as Record<string, unknown>)[options.field];
      if (fieldValue === undefined) {
        const availableFields = Object.keys(displayData as object).join(", ");
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
            dataId: data.id,
            dataName: data.name,
            version: data.version,
            contentType: data.contentType,
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
