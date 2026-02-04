import { Command } from "@cliffy/command";
import {
  type ArtifactInfo,
  type ModelMethodRunData,
  renderModelMethodRun,
} from "../../presentation/output/model_method_run_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodRunCommand = new Command()
  .name("run")
  .description("Execute a method on a model")
  .arguments("<model_id_or_name:model_name> <method_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, "model-method-run");
      const { repoDir, repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;
      const unifiedDataRepo = repoContext.unifiedDataRepo;
      const outputRepo = repoContext.outputRepo;
      const executionService = new DefaultMethodExecutionService();

      ctx.logger
        .debug`Running method '${methodName}' on model: ${modelIdOrName}`;

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

      // Get the model definition from registry
      const modelDef = modelRegistry.get(modelType);
      if (!modelDef) {
        throw new Error(`Unknown model type: ${modelType.normalized}`);
      }

      // Validate method exists on the model
      const method = modelDef.methods[methodName];
      if (!method) {
        const availableMethods = Object.keys(modelDef.methods).join(", ");
        throw new Error(
          `Unknown method '${methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      ctx.logger.debug`Executing method '${methodName}'`;

      // Create ModelOutput for tracking
      const definitionHash = await definition.computeHash();
      const output = ModelOutput.create({
        definitionId: definition.id,
        methodName,
        provenance: {
          definitionHash,
          modelVersion: definition.version,
          triggeredBy: "manual",
        },
      });

      // Mark as running and save
      output.markRunning();
      await outputRepo.save(modelType, methodName, output);

      // Track artifacts for output
      const dataArtifacts: ArtifactInfo[] = [];

      try {
        // Execute the method (use workflow execution to handle follow-up actions)
        const execResult = await executionService.executeWorkflow(
          definition,
          modelDef,
          methodName,
          {
            repoDir,
            modelType,
            modelId: definition.id,
            dataRepository: unifiedDataRepo,
            definitionRepository: definitionRepo,
          },
        );

        ctx.logger.debug`Method executed`;

        // Handle data output persistence
        if (execResult.dataOutputs && execResult.dataOutputs.length > 0) {
          for (const dataOutput of execResult.dataOutputs) {
            ctx.logger.debug`Saving data output: ${dataOutput.name}`;

            // Create Data entity from DataOutput
            const { Data } = await import("../../domain/data/mod.ts");
            const data = Data.create({
              name: dataOutput.name,
              contentType: dataOutput.metadata.contentType,
              lifetime: dataOutput.metadata.lifetime,
              garbageCollection: dataOutput.metadata.garbageCollection,
              streaming: dataOutput.metadata.streaming,
              tags: dataOutput.metadata.tags,
              ownerDefinition: dataOutput.metadata.ownerDefinition,
            });

            // Save the data
            const saveResult = await unifiedDataRepo.save(
              modelType,
              definition.id,
              data,
              dataOutput.content,
            );

            const dataPath = unifiedDataRepo.getPath(
              modelType,
              definition.id,
              dataOutput.name,
              saveResult.version,
            );
            ctx.logger.debug`Data saved to: ${dataPath}`;

            // Track artifact in output
            output.addDataArtifact({
              dataId: data.id,
              name: dataOutput.name,
              version: saveResult.version,
              tags: dataOutput.metadata.tags,
            });

            // Parse content if JSON for display purposes
            let attributes: Record<string, unknown> | undefined;
            if (dataOutput.metadata.contentType === "application/json") {
              try {
                const text = new TextDecoder().decode(dataOutput.content);
                attributes = JSON.parse(text) as Record<string, unknown>;
              } catch {
                // Not valid JSON, skip attributes
              }
            }

            dataArtifacts.push({
              id: data.id,
              path: dataPath,
              attributes,
            });
          }
        }

        // Mark output as succeeded and save
        output.markSucceeded();
        await outputRepo.save(modelType, methodName, output);
      } catch (error) {
        // Mark output as failed and save
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        output.markFailed({ message: errorMessage, stack: errorStack });
        await outputRepo.save(modelType, methodName, output);
        throw error;
      }

      // Render output based on output mode
      if (ctx.outputMode === "stream") {
        // Stream mode: print simple colored success message
        const GREEN = "\x1b[32m";
        const RESET = "\x1b[0m";
        const prefix = `${GREEN}[${definition.name}/${methodName}]${RESET}`;
        console.log(`${prefix} Method completed successfully`);
        for (const artifact of dataArtifacts) {
          console.log(`${prefix} Data: ${artifact.path}`);
        }
      } else {
        const data: ModelMethodRunData = {
          modelId: definition.id,
          modelName: definition.name,
          type: modelType.normalized,
          methodName,
          // Use first data artifact as primary data for backward compat
          data: dataArtifacts.length > 0 ? dataArtifacts[0] : undefined,
          // Additional data artifacts could be shown as logs (legacy output field)
          logs: dataArtifacts.length > 1 ? dataArtifacts.slice(1) : undefined,
        };

        renderModelMethodRun(data, ctx.outputMode);
      }
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
