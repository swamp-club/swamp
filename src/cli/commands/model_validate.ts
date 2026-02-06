import { Command } from "@cliffy/command";
import {
  type ModelValidateData,
  renderModelValidate,
  renderModelValidateAll,
  type ValidationItemData,
} from "../../presentation/output/model_validate_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  DefaultModelValidationService,
  type ValidationResult,
} from "../../domain/models/validation_service.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";

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
  .description("Validate a model definition against its schema")
  .arguments("[model_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const ctx = createContext(options as GlobalOptions, [
        "model",
        "validate",
      ]);
      const { repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;
      const validationService = new DefaultModelValidationService();

      // If no argument provided, validate all models
      if (!modelIdOrName) {
        ctx.logger.debug`Validating all models`;
        const allDefinitions = await definitionRepo.findAllGlobal();

        if (allDefinitions.length === 0) {
          throw new Error("No models found");
        }

        const results: ModelValidateData[] = [];
        for (const { definition, type } of allDefinitions) {
          const modelDef = modelRegistry.get(type);
          if (!modelDef) {
            continue;
          }

          const validationResults = await validationService.validateModel(
            definition,
            modelDef,
            definitionRepo,
          );

          const validations = toValidationItemData(validationResults);
          const allPassed = validationResults.every((r) => r.passed);

          results.push({
            modelId: definition.id,
            modelName: definition.name,
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

      // Look up the model definition
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      const result = await findDefinitionByIdOrName(
        definitionRepo,
        modelIdOrName,
      );
      if (!result) {
        throw new Error(`Model not found: ${modelIdOrName}`);
      }
      const { definition, type: modelType } = result;

      ctx.logger
        .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

      // Get the model definition
      const modelDef = modelRegistry.get(modelType);
      if (!modelDef) {
        throw new Error(`Unknown model type: ${modelType.normalized}`);
      }

      // Run validations
      const results = await validationService.validateModel(
        definition,
        modelDef,
        definitionRepo,
      );

      const validations = toValidationItemData(results);
      const allPassed = results.every((r) => r.passed);

      const data: ModelValidateData = {
        modelId: definition.id,
        modelName: definition.name,
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
