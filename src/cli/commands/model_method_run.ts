import { Command } from "@cliffy/command";
import {
  type ModelMethodRunData,
  renderModelMethodRun,
} from "../../presentation/output/model_method_run_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  createModelInputId,
  type ModelInput,
} from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";

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

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodRunCommand = new Command()
  .name("run")
  .description("Execute a method on a model")
  .arguments("<model_id_or_name:string> <method_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, "model-method-run");
      const repoDir = options.repoDir ?? ".";
      const inputRepo = new YamlInputRepository(repoDir);
      const resourceRepo = new YamlResourceRepository(repoDir);
      const executionService = new DefaultMethodExecutionService();

      ctx.logger
        .debug`Running method '${methodName}' on model: ${modelIdOrName}`;

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

      // Validate method exists on the model
      const method = definition.methods[methodName];
      if (!method) {
        const availableMethods = Object.keys(definition.methods).join(", ");
        throw new Error(
          `Unknown method '${methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      ctx.logger.debug`Executing method '${methodName}'`;

      // Execute the method (use workflow execution to handle follow-up actions)
      const result = await executionService.executeWorkflow(
        input,
        definition,
        methodName,
        { repoDir, resourceRepository: resourceRepo },
      );

      ctx.logger
        .debug`Method executed, resource created: ${result.resource.id}`;

      // Handle resource persistence based on operation type
      let resourcePath: string;
      if (result.deleteResource) {
        // Delete the resource file
        await resourceRepo.delete(modelType, result.resource.id);
        resourcePath = ""; // No path since resource was deleted
        ctx.logger.debug`Resource deleted: ${result.resource.id}`;
      } else {
        // Save the resource
        await resourceRepo.save(modelType, result.resource);
        resourcePath = resourceRepo.getPath(modelType, result.resource.id);
        ctx.logger.debug`Resource saved to: ${resourcePath}`;
      }

      // Update input's resourceId based on operation type
      if (result.deleteResource) {
        // For delete operations, clear the resourceId since the resource no longer exists
        if (input.resourceId) {
          input.setResourceId(undefined);
          await inputRepo.save(modelType, input);
          ctx.logger.debug`Input resourceId cleared after deletion`;
        }
      } else {
        // For create/update operations, set the resourceId if not already set
        if (!input.resourceId) {
          input.setResourceId(result.resource.id);
          await inputRepo.save(modelType, input);
          ctx.logger
            .debug`Input updated with resourceId: ${result.resource.id}`;
        } else {
          ctx.logger.debug`Input already has resourceId: ${input.resourceId}`;
        }
      }

      // Render output
      const data: ModelMethodRunData = {
        modelId: input.id,
        modelName: input.name,
        type: modelType.normalized,
        methodName,
        resourceId: result.resource.id,
        resourcePath,
        resourceAttributes: result.resource.attributes,
      };

      renderModelMethodRun(data, ctx.outputMode);
      ctx.logger.debug("Method run command completed");
    },
  );

export const modelMethodCommand = new Command()
  .name("method")
  .description("Execute model methods")
  .action(function () {
    this.showHelp();
  })
  .command("run", modelMethodRunCommand);
