import { Command } from "@cliffy/command";
import {
  type ModelGetData,
  renderModelGet,
  type ResourceData,
} from "../../presentation/output/model_get_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { inputIdToResourceId } from "../../domain/models/model_resource.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { findByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelGetCommand = new Command()
  .name("get")
  .description("Show details of a model input")
  .arguments("<model_id_or_name:model_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, "model-get");
    ctx.logger.debug`Getting model: ${modelIdOrName}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);
    const resourceRepo = new YamlResourceRepository(repoDir);

    // Look up the model input
    ctx.logger.debug`Looking up model: ${modelIdOrName}`;
    const result = await findByIdOrName(inputRepo, modelIdOrName);
    if (!result) {
      throw new UserError(`Model not found: ${modelIdOrName}`);
    }
    const { input, type: modelType } = result;

    ctx.logger.debug`Found model: id=${input.id}, type=${modelType.normalized}`;

    // Load the resource if it exists
    const resource = await resourceRepo.findById(
      modelType,
      inputIdToResourceId(input.id),
    );
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
