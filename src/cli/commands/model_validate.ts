import { Command } from "@cliffy/command";
import {
  type ModelValidateData,
  renderModelValidate,
  renderModelValidateAll,
  type ValidationItemData,
} from "../../presentation/output/model_validate_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import type { ModelInput } from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  DefaultModelValidationService,
  type ValidationResult,
} from "../../domain/models/validation_service.ts";
import {
  findInputByIdGlobal,
  isUuid,
} from "../../domain/models/model_lookup.ts";

/**
 * Converts ValidationResult array to ValidationItemData array for presentation.
 */
function toValidationItemData(
  results: ValidationResult[],
): ValidationItemData[] {
  return results.map((r) => ({
    name: r.name,
    passed: r.passed,
    error: r.error,
  }));
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelValidateCommand = new Command()
  .name("validate")
  .description("Validate a model input against its schema")
  .arguments("[model_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const ctx = createContext(options as GlobalOptions, "model-validate");
      const repoDir = options.repoDir ?? ".";
      const inputRepo = new YamlInputRepository(repoDir);
      const resourceRepo = new YamlResourceRepository(repoDir);
      const validationService = new DefaultModelValidationService();

      // If no argument provided, validate all models
      if (!modelIdOrName) {
        ctx.logger.debug`Validating all models`;
        const allInputs = await inputRepo.findAllGlobal();

        if (allInputs.length === 0) {
          throw new Error("No models found");
        }

        const results: ModelValidateData[] = [];
        for (const { input, type } of allInputs) {
          const definition = modelRegistry.get(type);
          if (!definition) {
            continue;
          }

          const resource = await resourceRepo.findByInputId(type, input.id);
          const validationResults = await validationService.validateModel(
            input,
            definition,
            resource,
          );

          const validations = toValidationItemData(validationResults);
          const allPassed = validationResults.every((r) => r.passed);

          results.push({
            modelId: input.id,
            modelName: input.name,
            type: type.normalized,
            validations,
            passed: allPassed,
          });
        }

        renderModelValidateAll(results, ctx.outputMode);

        const anyFailed = results.some((r) => !r.passed);
        ctx.logger.debug`Validation completed, anyFailed=${anyFailed}`;

        if (anyFailed) {
          Deno.exit(1);
        }
        return;
      }

      // Single model validation (existing behavior)
      ctx.logger.debug`Validating model: ${modelIdOrName}`;

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

      ctx.logger
        .debug`Found model: id=${input.id}, type=${modelType.normalized}`;

      // Get the model definition
      const definition = modelRegistry.get(modelType);
      if (!definition) {
        throw new Error(`Unknown model type: ${modelType.normalized}`);
      }

      // Load the resource if it exists
      const resource = await resourceRepo.findByInputId(modelType, input.id);
      ctx.logger.debug`Resource exists: ${resource !== null}`;

      // Run validations
      const results = await validationService.validateModel(
        input,
        definition,
        resource,
      );

      const validations = toValidationItemData(results);
      const allPassed = results.every((r) => r.passed);

      const data: ModelValidateData = {
        modelId: input.id,
        modelName: input.name,
        type: modelType.normalized,
        validations,
        passed: allPassed,
      };

      renderModelValidate(data, ctx.outputMode);
      ctx.logger.debug`Validation completed, passed=${allPassed}`;

      // Exit with code 1 if any validation failed
      if (!allPassed) {
        Deno.exit(1);
      }
    },
  );
