import { Command } from "@cliffy/command";
import {
  type ModelValidateData,
  renderModelValidate,
  type ValidationItemData,
} from "../../presentation/output/model_validate_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  createModelInputId,
  type ModelInput,
} from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  DefaultModelValidationService,
  type ValidationResult,
} from "../../domain/models/validation_service.ts";

/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checks if a string looks like a UUID.
 */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Finds an input by ID, searching across all registered model types.
 */
async function findInputByIdGlobal(
  inputRepo: YamlInputRepository,
  id: string,
): Promise<{ input: ModelInput; type: ModelType } | null> {
  const inputId = createModelInputId(id);

  for (const type of modelRegistry.types()) {
    const input = await inputRepo.findById(type, inputId);
    if (input) {
      return { input, type };
    }
  }

  return null;
}

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
  .arguments("<model_id_or_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    async function (options: AnyOptions, modelIdOrName: string) {
      const ctx = createContext(options as GlobalOptions, "model-validate");
      ctx.logger.debug`Validating model: ${modelIdOrName}`;

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
      const validationService = new DefaultModelValidationService();
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
