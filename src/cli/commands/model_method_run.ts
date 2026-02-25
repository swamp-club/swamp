// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

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
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import {
  getRunLogger,
  runFileSink,
} from "../../infrastructure/logging/logger.ts";
import { coerceInputTypes, parseInputs } from "../input_parser.ts";
import { parseTags } from "./data_search.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";
import { SecretRedactor } from "../../domain/secrets/mod.ts";
import { join } from "@std/path";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { modelMethodHistoryCommand } from "./model_method_history.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodRunCommand = new Command()
  .name("run")
  .description("Execute a method on a model")
  .example("Run a method", "swamp model method run my-server getSystemInfo")
  .example(
    "Run with inputs",
    "swamp model method run my-server deploy --input env=prod",
  )
  .arguments("<model_id_or_name:model_name> <method_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--last-evaluated",
    "Skip CEL evaluation, use previously evaluated definition",
    { default: false },
  )
  .option("--input <value:string>", "Input values (key=value or JSON)", {
    collect: true,
  })
  .option("--input-file <file:string>", "Input values from YAML file")
  .option(
    "--tag <tag:string>",
    "Add tag to produced data (KEY=VALUE, repeatable)",
    { collect: true },
  )
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
      const vaultService = await VaultService.fromRepository(repoDir);

      ctx.logger
        .debug`Running method '${methodName}' on model: ${modelIdOrName}`;

      // Parse input values
      const { inputs } = await parseInputs({
        input: options.input as string[] | undefined,
        inputFile: options.inputFile as string | undefined,
      });

      // Parse runtime tags
      const runtimeTags = options.tag
        ? parseTags(options.tag as string[])
        : undefined;

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

      // Coerce k=v string inputs to match schema types before validation
      const coercedInputs = definition.inputs
        ? coerceInputTypes(inputs, definition.inputs)
        : inputs;
      Object.assign(inputs, coercedInputs);

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
          throw new UserError(`Input validation failed:\n${errorMessages}`);
        }
        // Use inputs with defaults applied
        Object.assign(inputs, inputsWithDefaults);
      }

      // Create run logger for real-time output
      const runLogger = getRunLogger(definition.name, methodName);

      // Create secret redactor — populated during vault resolution, used by log sink and data writers
      const redactor = new SecretRedactor();

      // Register run file sink target for log persistence
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFilePath = join(
        swampPath(repoDir, SWAMP_SUBDIRS.outputs),
        modelType.normalized,
        methodName,
        `${definition.id}-${timestamp}.log`,
      );
      const runLogCategory: string[] = [];
      await runFileSink.register(runLogCategory, logFilePath, redactor);

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

      // Merge CLI inputs directly into method arguments
      // Inputs not handled by the definition's inputs schema go to method args
      const definitionInputKeys = definition.inputs
        ? Object.keys(
          (definition.inputs as { properties?: Record<string, unknown> })
            .properties || {},
        )
        : [];
      const overrideInputs = Object.fromEntries(
        Object.entries(inputs).filter(([key]) =>
          !definitionInputKeys.includes(key)
        ),
      );
      if (Object.keys(overrideInputs).length > 0) {
        for (const [key, value] of Object.entries(overrideInputs)) {
          evaluatedDefinition.setMethodArgument(methodName, key, value);
        }
      }

      // Resolve runtime expressions (vault and env) at runtime (never persisted)
      evaluatedDefinition = await evaluationService
        .resolveRuntimeExpressionsInDefinition(evaluatedDefinition, redactor);

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

      // Mark as running, set log file path, and save
      output.markRunning();
      output.setLogFile(logFilePath);
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
            globalArgs: evaluatedDefinition.globalArguments,
            definition: {
              id: evaluatedDefinition.id,
              name: evaluatedDefinition.name,
              version: evaluatedDefinition.version,
              tags: evaluatedDefinition.tags,
            },
            methodName,
            logger: runLogger,
            dataRepository: unifiedDataRepo,
            definitionRepository: definitionRepo,
            runtimeTags,
            vaultService,
          },
        );

        runLogger.info("Method executed");

        // Data is already persisted by DataWriter — extract artifact info from handles
        if (execResult.dataHandles && execResult.dataHandles.length > 0) {
          for (const handle of execResult.dataHandles) {
            const dataPath = unifiedDataRepo.getPath(
              modelType,
              definition.id,
              handle.name,
              handle.version,
            );

            runLogger.info("Data saved to {path}", {
              path: dataPath,
              name: handle.name,
            });

            // Track artifact in output
            output.addDataArtifact({
              dataId: handle.dataId,
              name: handle.name,
              version: handle.version,
              tags: handle.tags,
            });

            // Parse content if JSON for display purposes
            let attributes: Record<string, unknown> | undefined;
            if (handle.metadata.contentType === "application/json") {
              try {
                const content = await unifiedDataRepo.getContent(
                  modelType,
                  evaluatedDefinition.id,
                  handle.name,
                  handle.version,
                );
                if (content) {
                  const text = new TextDecoder().decode(content);
                  attributes = JSON.parse(text) as Record<string, unknown>;
                }
              } catch {
                // Not valid JSON, skip attributes
              }
            }

            dataArtifacts.push({
              id: handle.dataId,
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
        throw new UserError(errorMessage);
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

      // Unregister run file sink target
      runFileSink.unregister(runLogCategory);

      ctx.logger.debug("Method run command completed");
    },
  );

export const modelMethodCommand = new Command()
  .name("method")
  .description("Execute model methods")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("run", modelMethodRunCommand)
  .command("history", modelMethodHistoryCommand);
