import { Command } from "@cliffy/command";
import {
  type ModelGetData,
  renderModelGet,
  type ResourceData,
} from "../../presentation/output/model_get_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import type { ModelInput } from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import {
  findInputByIdGlobal,
  isUuid,
} from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelGetCommand = new Command()
  .name("get")
  .description("Show details of a model input")
  .arguments("<model_id_or_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, "model-get");
    ctx.logger.debug`Getting model: ${modelIdOrName}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);

    // Look up the model input
    let input: ModelInput;
    let modelType: ModelType;

    if (isUuid(modelIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${modelIdOrName}`;
      const result = await findInputByIdGlobal(inputRepo, modelIdOrName);
      if (!result) {
        throw new Error(`Model not found: ${modelIdOrName}`);
      }
      input = result.input;
      modelType = result.type;
    } else {
      ctx.logger.debug`Looking up by name: ${modelIdOrName}`;
      const result = await inputRepo.findByNameGlobal(modelIdOrName);
      if (!result) {
        throw new Error(`Model not found: ${modelIdOrName}`);
      }
      input = result.input;
      modelType = result.type;
    }

    ctx.logger.debug`Found model: id=${input.id}, type=${modelType.normalized}`;

    // Load the resource if it exists
    const resource = await resourceRepo.findByInputId(modelType, input.id);
    ctx.logger.debug`Resource exists: ${resource !== null}`;

    // Build resource data
    let resourceData: ResourceData | undefined;
    if (resource) {
      resourceData = {
        id: resource.id,
        createdAt: resource.createdAt.toISOString(),
        attributes: resource.attributes,
      };
    }

    const data: ModelGetData = {
      id: input.id,
      name: input.name,
      type: modelType.normalized,
      version: input.version,
      tags: input.tags,
      attributes: input.attributes,
      resource: resourceData,
    };

    renderModelGet(data, ctx.outputMode);
    ctx.logger.debug("Model get command completed");
  });
