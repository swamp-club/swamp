import { Command } from "@cliffy/command";
import {
  type DataVersionInfo,
  type DataVersionsData,
  renderDataVersions,
} from "../../presentation/output/data_versions_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataVersionsCommand = new Command()
  .name("versions")
  .description("List all versions of specific data")
  .arguments("<model_id_or_name:model_name> <data_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      dataName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, "data-versions");
      ctx.logger
        .debug`Listing versions: model=${modelIdOrName}, name=${dataName}`;

      const repoDir = options.repoDir ?? ".";
      const definitionRepo = new YamlDefinitionRepository(repoDir);
      const dataRepo = new FileSystemUnifiedDataRepository(repoDir);

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

      // Get all versions
      const versionNumbers = await dataRepo.listVersions(
        modelType,
        definition.id,
        dataName,
      );

      if (versionNumbers.length === 0) {
        throw new UserError(
          `Data "${dataName}" not found for model "${modelIdOrName}"`,
        );
      }

      // Get metadata for each version
      const versions: DataVersionInfo[] = [];
      const latestVersion = Math.max(...versionNumbers);

      for (const version of versionNumbers) {
        const data = await dataRepo.findByName(
          modelType,
          definition.id,
          dataName,
          version,
        );
        if (data) {
          versions.push({
            version: data.version,
            createdAt: data.createdAt.toISOString(),
            size: data.size,
            checksum: data.checksum,
            isLatest: version === latestVersion,
          });
        }
      }

      // Sort versions descending (newest first)
      versions.sort((a, b) => b.version - a.version);

      const output: DataVersionsData = {
        dataName,
        modelId: definition.id,
        modelName: definition.name,
        modelType: modelType.normalized,
        versions,
        total: versions.length,
      };

      renderDataVersions(output, ctx.outputMode);
      ctx.logger.debug("Data versions command completed");
    },
  );
