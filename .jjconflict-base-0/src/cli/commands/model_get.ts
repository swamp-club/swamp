import { Command } from "@cliffy/command";
import {
  type ModelGetData,
  renderModelGet,
} from "../../presentation/output/model_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelGetCommand = new Command()
  .name("get")
  .description("Show details of a model definition")
  .arguments("<model_id_or_name:model_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const ctx = createContext(options as GlobalOptions, ["model", "get"]);
    ctx.logger.debug`Getting model: ${modelIdOrName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;

    // Look up the model definition
    ctx.logger.debug`Looking up model: ${modelIdOrName}`;
    const result = await findDefinitionByIdOrName(
      definitionRepo,
      modelIdOrName,
    );
    if (!result) {
      throw new UserError(`Model not found: ${modelIdOrName}`);
    }
    const { definition, type: modelType } = result;

    ctx.logger
      .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

    const data: ModelGetData = {
      id: definition.id,
      name: definition.name,
      type: modelType.normalized,
      version: definition.version,
      tags: definition.tags,
      attributes: definition.attributes,
    };

    renderModelGet(data, ctx.outputMode);
    ctx.logger.debug("Model get command completed");
  });
