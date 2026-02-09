import { Command } from "@cliffy/command";
import {
  type ArtifactInfo,
  type ModelMethodRunData,
  renderModelMethodRun,
} from "../../presentation/output/model_method_run_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { getRunLogger } from "../../infrastructure/logging/logger.ts";
import { parseInputs } from "../input_parser.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";

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
  .option(
    "--last-evaluated",
    "Skip CEL evaluation, use previously evaluated definition",
    { default: false },
  )
  .option("--input <json:string>", "Input values as JSON")
  .option("--input-file <file:string>", "Input values from YAML file")
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, [
        "model",
        "method",
        "run",
      ]);
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

      // Parse input values
      const { inputs } = await parseInputs({
        input: options.input as string | undefined,
        inputFile: options.inputFile as string | undefined,
      });

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

      // Validate inputs against model's input schema if provided
      if (definition.inputs) {
        const validationService = new InputValidationService();
        const inputsWithDefaults = validationService.applyDefaults(
          inputs,
          definition.inputs,
        );
        const validationResult = validationService.validate(
          inputsWithDefaults,
          definition.inputs,
        );
        if (!validationResult.valid) {
          const errorMessages = validationResult.errors
            .map((e) => `  ${e.message}`)
            .join("\n");
          throw new Error(`Input validation failed:\n${errorMessages}`);
        }
        // Use inputs with defaults applied
        Object.assign(inputs, inputsWithDefaults);
      }

      // Create run logger for real-time output
      const runLogger = getRunLogger(definition.name, methodName);

      runLogger.info("Found model {name} ({type})", {
        name: definition.name,
        type: modelType.normalized,
      });

      // Get the model definition from registry
      const modelDef = modelRegistry.get(modelType);
      if (!modelDef) {
        throw new UserError(`Unknown model type: ${modelType.normalized}`);
      }

      // Validate method exists on the model
      const method = modelDef.methods[methodName];
      if (!method) {
        const availableMethods = Object.keys(modelDef.methods).join(", ");
        throw new UserError(
          `Unknown method '${methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      const evaluationService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
        { dataRepo: unifiedDataRepo },
      );

      const lastEvaluated = options.lastEvaluated as boolean;
      let evaluatedDefinition = definition;

      if (lastEvaluated) {
        // Load previously-evaluated definition from cache
        runLogger.info("Loading last evaluated definition");
        const evaluatedDefRepo = repoContext.evaluatedDefinitionRepo;
        const lastEval = await evaluatedDefRepo.findByName(
          modelType,
          definition.name,
        );
        if (!lastEval) {
          throw new UserError(
            `No previously evaluated definition found for "${definition.name}".\n\n` +
              `Run the method without --last-evaluated first to generate evaluated data:\n` +
              `  swamp model method run ${definition.name} ${methodName}`,
          );
        }
        evaluatedDefinition = lastEval;
      } else {
        // Evaluate CEL expressions (vault expressions left raw for persistence)
        if (
          evaluationService.hasDefinitionExpressions(definition) ||
          Object.keys(inputs).length > 0
        ) {
          runLogger.info("Evaluating expressions");
          const evalResult = await evaluationService.evaluateDefinition(
            definition,
            modelType,
            inputs,
          );
          evaluatedDefinition = evalResult.definition;
        }

        // Save evaluated definition (with vault expressions still raw) for --last-evaluated
        const evaluatedDefRepo = repoContext.evaluatedDefinitionRepo;
        await evaluatedDefRepo.save(modelType, evaluatedDefinition);
      }

      // Resolve vault expressions at runtime (never persisted)
      evaluatedDefinition = await evaluationService
        .resolveVaultExpressionsInDefinition(evaluatedDefinition);

      runLogger.info("Executing method {method}", { method: methodName });

      // Create ModelOutput for tracking (use original definition for provenance)
      const definitionHash = await definition.computeHash();
      const output = ModelOutput.create({
        definitionId: definition.id,
        methodName,
        provenance: {
          definitionHash,
          modelVersion: modelDef.version,
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
        // Use evaluatedDefinition which has vault expressions resolved
        const execResult = await executionService.executeWorkflow(
          evaluatedDefinition,
          modelDef,
          methodName,
          {
            repoDir,
            modelType,
            modelId: evaluatedDefinition.id,
            dataRepository: unifiedDataRepo,
            definitionRepository: definitionRepo,
          },
        );

        runLogger.info("Method executed");

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

            runLogger.info("Data saved to {path}", {
              path: dataPath,
              name: dataOutput.name,
            });

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

        runLogger.error("Method {method} failed: {error}", {
          method: methodName,
          model: definition.name,
          error: errorMessage,
        });
        throw error;
      }

      // JSON mode: use existing render function
      if (ctx.outputMode === "json") {
        const data: ModelMethodRunData = {
          modelId: definition.id,
          modelName: definition.name,
          type: modelType.normalized,
          methodName,
          data: dataArtifacts.length > 0 ? dataArtifacts[0] : undefined,
          logs: dataArtifacts.length > 1 ? dataArtifacts.slice(1) : undefined,
        };

        renderModelMethodRun(data, ctx.outputMode);
      } else {
        // Interactive/stream: summary as final log line
        runLogger.with({ summary: true }).info(
          "Method {method} completed on {model}",
          {
            method: methodName,
            model: definition.name,
            artifacts: dataArtifacts.length,
          },
        );
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
