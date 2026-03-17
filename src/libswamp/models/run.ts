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

import { cancelled, type SwampError } from "../errors.ts";
import { inputValidationFailed } from "../workflows/run.ts";
import type { LibSwampContext } from "../context.ts";
import type { MethodExecutionEvent } from "../../domain/models/method_events.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import type { InputsSchema } from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import type { MethodExecutionService } from "../../domain/models/method_execution_service.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { OutputRepository } from "../../domain/models/repositories.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import type { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import type { SecretRedactor } from "../../domain/secrets/mod.ts";
import type {
  DataArtifactView,
  ModelMethodRunView,
} from "./model_method_run_view.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import {
  coerceInputTypes,
  InputValidationService,
} from "../../domain/inputs/mod.ts";
import { extractInputReferences } from "../../domain/expressions/expression_parser.ts";
import { withEventBridge } from "../../infrastructure/stream/event_bridge.ts";
import type { MethodResult } from "../../domain/models/model.ts";
import { getRunLogger } from "../../infrastructure/logging/logger.ts";

/**
 * Events emitted by the libswamp model method run generator.
 */
export type ModelMethodRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "resolving_model"; modelIdOrName: string }
  | {
    kind: "model_resolved";
    modelName: string;
    modelType: string;
    methodName: string;
  }
  | { kind: "evaluating_expressions"; lastEvaluated: boolean }
  | { kind: "executing"; modelName: string; methodName: string }
  | {
    kind: "method_output";
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    modelName: string;
    methodName: string;
    event: MethodExecutionEvent;
  }
  | { kind: "data_artifact_saved"; name: string; path: string }
  | { kind: "completed"; run: ModelMethodRunView }
  | { kind: "error"; error: SwampError };

/**
 * Log context for a single model method run.
 */
export interface RunLog {
  logFilePath: string;
  redactor: SecretRedactor;
  cleanup: () => void;
}

/**
 * Dependencies injected into the model method run generator.
 */
export interface ModelMethodRunDeps {
  repoDir: string;
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
  createEvaluationService: () => ExpressionEvaluationService;
  loadEvaluatedDefinition: (
    type: ModelType,
    name: string,
  ) => Promise<Definition | null>;
  saveEvaluatedDefinition: (
    type: ModelType,
    definition: Definition,
  ) => Promise<void>;
  createExecutionService: () => MethodExecutionService;
  createVaultService: () => Promise<VaultService>;
  dataRepo: UnifiedDataRepository;
  definitionRepo: YamlDefinitionRepository;
  outputRepo: OutputRepository;
  createRunLog: (
    modelType: ModelType,
    methodName: string,
    definitionId: string,
  ) => Promise<RunLog>;
}

/**
 * Input for the model method run generator.
 */
export interface ModelMethodRunInput {
  modelIdOrName: string;
  methodName: string;
  inputs: Record<string, unknown>;
  lastEvaluated: boolean;
  runtimeTags?: Record<string, string>;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  skipAllChecks?: boolean;
  driver?: string;
}

/**
 * Executes a model method, yielding progress events as a libswamp stream.
 */
export async function* modelMethodRun(
  ctx: LibSwampContext,
  deps: ModelMethodRunDeps,
  input: ModelMethodRunInput,
): AsyncGenerator<ModelMethodRunEvent> {
  // --- Validate inputs phase ---
  yield { kind: "validating_inputs" };

  // --- Resolve model ---
  yield { kind: "resolving_model", modelIdOrName: input.modelIdOrName };

  const lookupResult = await deps.lookupDefinition(input.modelIdOrName);
  if (!lookupResult) {
    yield { kind: "error", error: modelNotFound(input.modelIdOrName) };
    return;
  }
  const { definition, type: modelType } = lookupResult;

  // Get model definition from registry (may auto-resolve if async)
  const modelDef = await Promise.resolve(deps.getModelDef(modelType));
  if (!modelDef) {
    yield { kind: "error", error: unknownModelType(modelType.normalized) };
    return;
  }

  // Validate method exists
  const method = modelDef.methods[input.methodName];
  if (!method) {
    const availableMethods = Object.keys(modelDef.methods).join(", ");
    yield {
      kind: "error",
      error: unknownMethod(
        input.methodName,
        modelType.normalized,
        availableMethods,
      ),
    };
    return;
  }

  // Coerce and validate inputs against model's input schema
  const inputs = { ...input.inputs };
  if (definition.inputs) {
    const coercedInputs = coerceInputTypes(inputs, definition.inputs);
    Object.assign(inputs, coercedInputs);

    const validationService = new InputValidationService();
    const inputsWithDefaults = validationService.applyDefaults(
      inputs,
      definition.inputs,
    );

    // Build effective schema: only require inputs referenced by the method's arguments
    const referencedInputs = extractInputReferences(
      definition.getMethodArguments(input.methodName),
    );
    const originalRequired = definition.inputs.required ?? [];
    const effectiveRequired = originalRequired.filter((name) =>
      referencedInputs.has(name)
    );
    const effectiveSchema: InputsSchema = {
      ...definition.inputs,
      required: effectiveRequired,
    };

    const validationResult = validationService.validate(
      inputsWithDefaults,
      effectiveSchema,
    );
    if (!validationResult.valid) {
      yield {
        kind: "error",
        error: inputValidationFailed(validationResult.errors),
      };
      return;
    }
    Object.assign(inputs, inputsWithDefaults);
  }

  yield {
    kind: "model_resolved",
    modelName: definition.name,
    modelType: modelType.normalized,
    methodName: input.methodName,
  };

  // --- Set up logging ---
  const runLog = await deps.createRunLog(
    modelType,
    input.methodName,
    definition.id,
  );
  const { logFilePath, redactor } = runLog;

  try {
    // --- Evaluate expressions ---
    yield {
      kind: "evaluating_expressions",
      lastEvaluated: input.lastEvaluated,
    };

    const evaluationService = deps.createEvaluationService();
    let evaluatedDefinition = definition;

    if (input.lastEvaluated) {
      const lastEval = await deps.loadEvaluatedDefinition(
        modelType,
        definition.name,
      );
      if (!lastEval) {
        yield {
          kind: "error",
          error: noEvaluatedDefinition(definition.name),
        };
        return;
      }
      evaluatedDefinition = lastEval;
    } else {
      if (
        evaluationService.hasDefinitionExpressions(definition) ||
        Object.keys(inputs).length > 0
      ) {
        const evalResult = await evaluationService.evaluateDefinition(
          definition,
          modelType,
          inputs,
        );
        evaluatedDefinition = evalResult.definition;
      }
      await deps.saveEvaluatedDefinition(modelType, evaluatedDefinition);
    }

    // Merge override inputs into method arguments
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
        evaluatedDefinition.setMethodArgument(input.methodName, key, value);
      }
    }

    // Resolve runtime expressions (vault and env)
    evaluatedDefinition = await evaluationService
      .resolveRuntimeExpressionsInDefinition(evaluatedDefinition, redactor);

    // --- Execute ---
    yield {
      kind: "executing",
      modelName: definition.name,
      methodName: input.methodName,
    };

    // Create ModelOutput for tracking
    const definitionHash = await definition.computeHash();
    const output = ModelOutput.create({
      definitionId: definition.id,
      methodName: input.methodName,
      provenance: {
        definitionHash,
        modelVersion: modelDef.version,
        triggeredBy: "manual",
      },
    });
    output.markRunning();
    output.setLogFile(logFilePath);
    await deps.outputRepo.save(modelType, input.methodName, output);

    const vaultService = await deps.createVaultService();
    const executionService = deps.createExecutionService();

    let execResult: MethodResult;
    try {
      execResult = yield* withEventBridge<
        ModelMethodRunEvent,
        MethodResult
      >(
        (push) =>
          executionService.executeWorkflow(
            evaluatedDefinition,
            modelDef,
            input.methodName,
            {
              signal: ctx.signal,
              repoDir: deps.repoDir,
              modelType,
              modelId: evaluatedDefinition.id,
              globalArgs: evaluatedDefinition.globalArguments,
              definition: {
                id: evaluatedDefinition.id,
                name: evaluatedDefinition.name,
                version: evaluatedDefinition.version,
                tags: evaluatedDefinition.tags,
              },
              methodName: input.methodName,
              logger: getRunLogger(definition.name, input.methodName),
              dataRepository: deps.dataRepo,
              definitionRepository: deps.definitionRepo,
              runtimeTags: input.runtimeTags,
              vaultService,
              redactor,
              skipCheckNames: input.skipCheckNames,
              skipCheckLabels: input.skipCheckLabels,
              skipAllChecks: input.skipAllChecks,
              driver: input.driver,
              onEvent: (event: MethodExecutionEvent) => {
                if (event.type === "output") {
                  push({
                    kind: "method_output",
                    modelName: definition.name,
                    methodName: input.methodName,
                    stream: event.stream,
                    line: event.line,
                  });
                } else {
                  push({
                    kind: "method_event",
                    modelName: definition.name,
                    methodName: input.methodName,
                    event,
                  });
                }
              },
            },
          ),
      );
    } catch (error) {
      // Mark output as failed and save
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      output.markFailed({ message: errorMessage, stack: errorStack });
      await deps.outputRepo.save(modelType, input.methodName, output);

      if (
        error instanceof DOMException && error.name === "AbortError"
      ) {
        yield { kind: "error", error: cancelled(error) };
        return;
      }

      yield { kind: "error", error: methodExecutionFailed(error) };
      return;
    }

    // --- Process data artifacts ---
    const dataArtifacts: DataArtifactView[] = [];
    if (execResult.dataHandles && execResult.dataHandles.length > 0) {
      for (const handle of execResult.dataHandles) {
        const dataPath = deps.dataRepo.getPath(
          modelType,
          definition.id,
          handle.name,
          handle.version,
        );

        output.addDataArtifact({
          dataId: handle.dataId,
          name: handle.name,
          version: handle.version,
          tags: handle.tags,
        });

        // Parse content if JSON for display
        let attributes: Record<string, unknown> | undefined;
        if (handle.metadata.contentType === "application/json") {
          try {
            const content = await deps.dataRepo.getContent(
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
          name: handle.name,
          path: dataPath,
          attributes,
        });
        yield {
          kind: "data_artifact_saved",
          name: handle.name,
          path: dataPath,
        };
      }
    }

    // Mark output as succeeded and save
    output.markSucceeded();
    await deps.outputRepo.save(modelType, input.methodName, output);

    // --- Complete ---
    const view: ModelMethodRunView = {
      modelId: definition.id,
      modelName: definition.name,
      modelType: modelType.normalized,
      methodName: input.methodName,
      status: "succeeded",
      duration: output.durationMs,
      outputId: output.id,
      logFile: logFilePath,
      dataArtifacts,
    };
    yield { kind: "completed", run: view };
  } finally {
    runLog.cleanup();
  }
}

/**
 * Creates a SwampError for a missing model.
 */
export function modelNotFound(idOrName: string): SwampError {
  return {
    code: "model_not_found",
    message: `Model not found: ${idOrName}`,
  };
}

/**
 * Creates a SwampError for an unknown model type.
 */
export function unknownModelType(type: string): SwampError {
  return {
    code: "unknown_model_type",
    message: `Unknown model type: ${type}`,
  };
}

/**
 * Creates a SwampError for an unknown method.
 */
export function unknownMethod(
  methodName: string,
  modelType: string,
  availableMethods: string,
): SwampError {
  return {
    code: "unknown_method",
    message:
      `Unknown method '${methodName}' for type '${modelType}'. Available methods: ${
        availableMethods || "none"
      }`,
  };
}

/**
 * Creates a SwampError when no evaluated definition is available for --last-evaluated.
 */
export function noEvaluatedDefinition(
  name: string,
): SwampError {
  return {
    code: "no_evaluated_definition",
    message: `No previously evaluated definition found for "${name}".`,
  };
}

/**
 * Creates a SwampError for a method execution failure.
 */
export function methodExecutionFailed(cause: unknown): SwampError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    code: "method_execution_failed",
    message,
    cause: cause instanceof Error ? cause : undefined,
  };
}
