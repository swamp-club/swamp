import { Command } from "@cliffy/command";
import {
  type DataGetData,
  renderDataGet,
} from "../../presentation/output/data_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataGetCommand = new Command()
  .name("get")
  .description("Get data by model and name")
  .arguments("<model_id_or_name:model_name> <data_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--version <version:number>", "Specific version (defaults to latest)")
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      dataName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, ["data", "get"]);
      ctx.logger.debug`Getting data: model=${modelIdOrName}, name=${dataName}`;

      const { repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;
      const dataRepo = repoContext.unifiedDataRepo;

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

      // Get the data
      const version = options.version as number | undefined;
      const data = await dataRepo.findByName(
        modelType,
        definition.id,
        dataName,
        version,
      );

      if (!data) {
        const versionInfo = version ? ` (version ${version})` : "";
        throw new UserError(
          `Data "${dataName}" not found for model "${modelIdOrName}"${versionInfo}`,
        );
      }

      const contentPath = dataRepo.getContentPath(
        modelType,
        definition.id,
        dataName,
        data.version,
      );

      const output: DataGetData = {
        id: data.id,
        name: data.name,
        modelId: definition.id,
        modelName: definition.name,
        modelType: modelType.normalized,
        version: data.version,
        contentType: data.contentType,
        lifetime: data.lifetime,
        garbageCollection: data.garbageCollection,
        streaming: data.streaming,
        tags: data.tags,
        ownerDefinition: data.ownerDefinition,
        createdAt: data.createdAt.toISOString(),
        size: data.size,
        checksum: data.checksum,
        contentPath,
      };

      renderDataGet(output, ctx.outputMode);
      ctx.logger.debug("Data get command completed");
    },
  );
