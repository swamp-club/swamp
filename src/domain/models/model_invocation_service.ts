// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { join, resolve, SEPARATOR } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { Definition } from "../definitions/definition.ts";
import { parseExtensionManifest } from "../extensions/extension_manifest.ts";
import type {
  InvocationTracking,
  MethodContext,
  ModelDefinition,
  RunModelByDefinition,
  RunModelByType,
  RunModelOptions,
  RunModelResult,
} from "./model.ts";
import { ModelType } from "./model_type.ts";
import type { MethodExecutionService } from "./method_execution_service.ts";
import { findDefinitionByIdOrName } from "./model_lookup.ts";
import { modelRegistry } from "./model.ts";
import { resolveModelType } from "../extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../extensions/auto_resolver_context.ts";
import { buildMethodContext } from "./method_context.ts";
import type { CommonMethodContextDeps } from "./method_context.ts";
import { getObjectShape, isRecordSchema } from "./zod_type_coercion.ts";
import {
  collectAuthoredExpressions,
  type ExpressionEvaluationService,
} from "../expressions/expression_evaluation_service.ts";
import { UnresolvedExpressionError } from "../expressions/errors.ts";
import { assertMethodArgumentsEvaluated } from "../expressions/unresolved_expression_guard.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import type { ExpressionLocation } from "../expressions/expression.ts";
import {
  isForeignExpression,
  readsSwampBinding,
} from "../expressions/swamp_namespaces.ts";
import { RunSensitiveValues } from "../secrets/run_sensitive_values.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { InputValidationService } from "../inputs/input_validation_service.ts";
import { extractSensitiveFieldValues } from "./sensitive_field_extractor.ts";
import { keyPath, ProvenanceMap } from "../expressions/provenance_map.ts";
import { attachBindingProvenance } from "../expressions/splice_origin.ts";
import {
  type BehaviorWords,
  markModelWording,
  wordedText,
} from "../behavior_wording.ts";

const MAX_INVOCATION_DEPTH = 10;
const MAX_INVOCATION_BREADTH = 100;

const logger = getLogger(["swamp", "model", "invocation"]);

/**
 * A runModel failure whose message reads in behavior words, carrying its
 * model spelling for `swamp model …` (swamp-club#3437).
 */
function wordedFailure(
  build: (words: BehaviorWords) => string,
): RunModelResult {
  const worded = wordedText(build);
  return {
    ok: false,
    error: markModelWording({ message: worded.text }, worded.modelText),
  };
}

export interface ModelInvocationServiceDeps {
  executionService: MethodExecutionService;
  commonDeps: CommonMethodContextDeps;
  /**
   * Evaluates the target definition's expressions before the nested run, as
   * a standalone run of that definition would.
   */
  evaluationService: Pick<
    ExpressionEvaluationService,
    | "hasDefinitionExpressions"
    | "evaluateDefinition"
    | "buildRuntimeContext"
    | "resolveRuntimeExpressionsInDefinition"
  >;
  repoDir: string;
  pulledExtensionsRoot?: string;
}

function isRunModelByType(
  options: RunModelOptions,
): options is RunModelByType {
  return "modelType" in options;
}

interface ResolveSuccess {
  ok: true;
  definition: Definition;
  modelDef: ModelDefinition;
}

type ResolveResult = ResolveSuccess | RunModelResult;

function isResolveSuccess(r: ResolveResult): r is ResolveSuccess {
  return r.ok && "definition" in r;
}

function ancestorKey(modelType: string, method: string): string {
  return `${modelType}::${method}`;
}

interface RoutedArgs {
  globalArgs: Record<string, unknown>;
  methodArgs: Record<string, unknown>;
}

function routeArguments(
  args: Record<string, unknown>,
  methodName: string,
  modelDef: ModelDefinition,
): RoutedArgs | RunModelResult {
  const method = modelDef.methods[methodName];
  if (!method) {
    return wordedFailure((w) =>
      `Method "${methodName}" not found on ${w.noun} type "${modelDef.type.normalized}".`
    );
  }

  const methodShape = getObjectShape(method.arguments);
  const methodIsRecord = isRecordSchema(method.arguments);
  const globalShape = modelDef.globalArguments
    ? getObjectShape(modelDef.globalArguments)
    : null;

  const methodKeys = methodShape
    ? new Set(Object.keys(methodShape))
    : new Set<string>();
  const globalKeys = globalShape
    ? new Set(Object.keys(globalShape))
    : new Set<string>();

  const globalArgs: Record<string, unknown> = {};
  const methodArgs: Record<string, unknown> = {};
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (methodKeys.has(key)) {
      methodArgs[key] = value;
    } else if (globalKeys.has(key)) {
      globalArgs[key] = value;
    } else if (methodIsRecord) {
      methodArgs[key] = value;
    } else {
      unknownKeys.push(key);
    }
  }

  if (unknownKeys.length > 0) {
    const allValid = [...methodKeys, ...globalKeys];
    return {
      ok: false,
      error: {
        message: `Unknown argument(s): ${unknownKeys.join(", ")}. ` +
          `Valid arguments are: ${allValid.join(", ") || "none"}`,
      },
    };
  }

  return { globalArgs, methodArgs };
}

function isRoutedArgs(
  r: RoutedArgs | RunModelResult,
): r is RoutedArgs {
  return "globalArgs" in r;
}

/**
 * runModel arguments come from extension code at run time, never from the
 * definition's author, so they are applied as literal values and never
 * evaluated. Global arguments holding `${{ ... }}` text that swamp could
 * evaluate are refused: they would reach the method unresolved, or — saved by
 * type-mode auto-creation — be evaluated as authored on a later run. Only
 * another templating system's text, such as `${{ github.sha }}`, passes.
 */
function refuseEvaluableGlobalArgs(
  definitionName: string,
  globalArgs: Record<string, unknown>,
): RunModelResult | null {
  const refused: ExpressionLocation[] = extractExpressions(globalArgs)
    .filter((e) =>
      readsSwampBinding(e.celExpression) ||
      !isForeignExpression(e.celExpression)
    );
  if (refused.length === 0) return null;
  const list = refused.map((e) => `  ${e.path}: ${e.raw}`).join("\n");
  return {
    ok: false,
    error: {
      message:
        `Refusing to run '${definitionName}': the following global arguments passed to runModel hold expression text, and runModel arguments are applied as literal values, never evaluated:\n${list}\nResolve the value in the calling method and pass the result instead.`,
    },
  };
}

export class ModelInvocationService {
  readonly #deps: ModelInvocationServiceDeps;

  constructor(deps: ModelInvocationServiceDeps) {
    this.#deps = deps;
  }

  async invoke(
    options: RunModelOptions,
    callerContext: MethodContext,
  ): Promise<RunModelResult> {
    callerContext._invocationTracking ??= {
      depth: 0,
      ancestors: new Set<string>(),
      breadthCounter: { count: 0 },
    };
    const tracking = callerContext._invocationTracking;

    if (tracking.depth >= MAX_INVOCATION_DEPTH) {
      return wordedFailure((w) =>
        `Maximum cross-${w.noun} invocation depth (${MAX_INVOCATION_DEPTH}) exceeded. ` +
        `Check for deep nesting chains in your runModel calls.`
      );
    }

    tracking.breadthCounter.count++;
    if (tracking.breadthCounter.count > MAX_INVOCATION_BREADTH) {
      return wordedFailure((w) =>
        `Maximum cross-${w.noun} invocation count (${MAX_INVOCATION_BREADTH}) exceeded ` +
        `in this execution. Reduce the number of runModel calls.`
      );
    }

    let definition: Definition;
    let modelDef: ModelDefinition;
    let methodName: string;

    if (isRunModelByType(options)) {
      methodName = options.method;
      const resolved = await this.#resolveByType(options);
      if (!isResolveSuccess(resolved)) return resolved as RunModelResult;
      definition = resolved.definition;
      modelDef = resolved.modelDef;
    } else {
      methodName = options.method;
      const resolved = await this.#resolveByDefinition(options);
      if (!isResolveSuccess(resolved)) return resolved as RunModelResult;
      definition = resolved.definition;
      modelDef = resolved.modelDef;
    }

    const targetType = modelDef.type.normalized;
    const key = ancestorKey(targetType, methodName);
    if (tracking.ancestors.has(key)) {
      return {
        ok: false,
        error: {
          message:
            `Cycle detected: ${callerContext.modelType.normalized}::${callerContext.methodName} → ` +
            `${targetType}::${methodName} is already in the ancestor chain.`,
        },
      };
    }

    const authError = await this.#checkAuthorization(
      callerContext,
      modelDef,
    );
    if (authError) return authError;

    callerContext.onEvent?.({
      type: "nested_model_invocation",
      targetModelType: targetType,
      targetMethod: methodName,
      callerModelType: callerContext.modelType.normalized,
      callerMethod: callerContext.methodName,
    });

    const childAncestors = new Set(tracking.ancestors);
    childAncestors.add(
      ancestorKey(callerContext.modelType.normalized, callerContext.methodName),
    );

    const childTracking: InvocationTracking = {
      depth: tracking.depth + 1,
      ancestors: childAncestors,
      breadthCounter: tracking.breadthCounter,
    };

    let routedGlobalArgs: Record<string, unknown> = {};
    let routedMethodArgs: Record<string, unknown> = {};
    if (options.arguments && Object.keys(options.arguments).length > 0) {
      const routed = routeArguments(options.arguments, methodName, modelDef);
      if (!isRoutedArgs(routed)) return routed;
      const refused = refuseEvaluableGlobalArgs(
        definition.name,
        routed.globalArgs,
      );
      if (refused) return refused;
      routedGlobalArgs = routed.globalArgs;
      routedMethodArgs = routed.methodArgs;
    }

    const redactor = callerContext.redactor ?? this.#deps.commonDeps.redactor;
    let childDefinition: Definition;
    let secretBag: VaultSecretBag;
    try {
      const resolved = await this.#resolveExpressions(
        definition,
        modelDef,
        methodName,
        routedGlobalArgs,
        routedMethodArgs,
        redactor,
      );
      childDefinition = resolved.definition;
      secretBag = resolved.secretBag;
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error &&
              !(error instanceof UnresolvedExpressionError)
            ? error.stack
            : undefined,
        },
      };
    }

    const childContext = buildMethodContext(
      // buildMethodContext takes the redactor only from the common deps.
      { ...this.#deps.commonDeps, redactor },
      {
        signal: callerContext.signal,
        repoDir: this.#deps.repoDir,
        modelType: modelDef.type,
        modelId: childDefinition.id,
        globalArgs: childDefinition.globalArguments,
        definition: {
          id: childDefinition.id,
          name: childDefinition.name,
          version: childDefinition.version,
          tags: childDefinition.tags ?? {},
        },
        methodName,
        logger: getLogger([
          "swamp",
          "model",
          "run",
          childDefinition.name,
          methodName,
        ]),
        extensionFilesRoot: modelDef.extensionFilesRoot,
        // The nested run's own vault values; the caller's bag is never passed.
        vaultSecrets: secretBag,
      },
    );
    childContext._invocationTracking = childTracking;

    const callerModelDef = modelRegistry.get(callerContext.modelType);
    childContext._invocationProvenance = {
      triggeredBy: "model",
      parentOutputId: callerContext._currentOutputId,
      callerExtension: callerModelDef?.extensionName,
    };

    try {
      const result = await this.#deps.executionService.executeWorkflow(
        childDefinition,
        modelDef,
        methodName,
        childContext,
      );

      return { ok: true, resources: result.dataHandles ?? [] };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
    }
  }

  /**
   * Evaluates the target definition in memory as `swamp model method run`
   * would: the definition pass, then the runtime pass for vault and env
   * expressions, within the caller's vault access scope. Expressions are
   * collected from the stored definition before any caller value is set, so
   * runModel arguments are applied literally — template-free global
   * arguments before evaluation (so `self.globalArguments` sees them), the
   * rest after both passes. Nothing is persisted.
   */
  async #resolveExpressions(
    definition: Definition,
    modelDef: ModelDefinition,
    methodName: string,
    routedGlobalArgs: Record<string, unknown>,
    routedMethodArgs: Record<string, unknown>,
    redactor: MethodContext["redactor"],
  ): Promise<{ definition: Definition; secretBag: VaultSecretBag }> {
    const evaluationService = this.#deps.evaluationService;
    const authoredExpressions = collectAuthoredExpressions(definition.toData());
    const sensitiveValues = new RunSensitiveValues(redactor);
    const inputs = definition.inputs
      ? new InputValidationService().applyDefaults({}, definition.inputs)
      : {};

    let evaluatedDefinition = Definition.fromData(definition.toData());
    const templatedGlobalArgs: Record<string, unknown> = {};
    // Caller values are data: a template-free one set here is spliced by
    // the definition pass like any other data, so it can never complete an
    // expression that reads as authored (swamp-club#3205).
    let definitionMap = ProvenanceMap.authored();
    for (const [key, value] of Object.entries(routedGlobalArgs)) {
      if (extractExpressions(value).length === 0) {
        evaluatedDefinition.setGlobalArgument(key, value);
        definitionMap = definitionMap.withWholeData(
          keyPath("globalArguments", key),
        );
      } else {
        templatedGlobalArgs[key] = value;
      }
    }

    let executedDefinition = evaluatedDefinition;
    const stepSecretBag = new VaultSecretBag(sensitiveValues.sentinels);
    let failedExpressions: ReadonlyMap<string, Error> = new Map();
    // Where data sits in each copy, carried into the runtime pass so data
    // the definition pass spliced is never resolved there.
    let rawProvenance = definitionMap;
    let executedProvenance = definitionMap;
    if (evaluationService.hasDefinitionExpressions(evaluatedDefinition)) {
      const evalResult = await evaluationService.evaluateDefinition(
        evaluatedDefinition,
        modelDef.type,
        sensitiveValues,
        inputs,
        undefined,
        stepSecretBag,
        { definition: { raw: definitionMap, sanitized: definitionMap } },
      );
      evaluatedDefinition = evalResult.definition;
      executedDefinition = evalResult.sanitizedDefinition ??
        evalResult.definition;
      failedExpressions = evalResult.failedExpressions ?? failedExpressions;
      rawProvenance = evalResult.provenance ?? definitionMap;
      executedProvenance = evalResult.sanitizedProvenance ?? rawProvenance;
    }

    const runtimeContext = await evaluationService.buildRuntimeContext(
      executedDefinition,
      sensitiveValues,
      inputs,
    );
    attachBindingProvenance(runtimeContext, {
      self: ProvenanceMap.authored().graft(
        "globalArguments",
        rawProvenance.subtree("globalArguments"),
      ),
    });
    const runtimeResult = await evaluationService
      .resolveRuntimeExpressionsInDefinition(
        executedDefinition,
        redactor,
        runtimeContext,
        authoredExpressions,
        {
          secretBag: stepSecretBag,
          rawGlobalArguments: evaluatedDefinition.globalArguments,
          provenance: executedProvenance,
        },
      );
    const resolvedDefinition = runtimeResult.definition;
    // Definition tags reach data artifacts and the catalog as they are, so a
    // sensitive value in one becomes its placeholder.
    for (const [key, value] of Object.entries(resolvedDefinition.tags)) {
      const placeholder = sensitiveValues.withPlaceholders(value);
      if (placeholder !== value) resolvedDefinition.setTag(key, placeholder);
    }

    for (const [key, value] of Object.entries(templatedGlobalArgs)) {
      resolvedDefinition.setGlobalArgument(key, value);
    }
    for (const [key, value] of Object.entries(routedMethodArgs)) {
      evaluatedDefinition.setMethodArgument(methodName, key, value);
      resolvedDefinition.setMethodArgument(methodName, key, value);
    }
    // Checked after the caller's arguments are applied, so one that replaces
    // a failed expression wins, as an --input does on the CLI.
    assertMethodArgumentsEvaluated(
      methodName,
      evaluatedDefinition.getMethodArguments(methodName),
      failedExpressions,
    );

    // Register sensitive argument values with the redactor so the nested
    // run's logs and data are scrubbed of them.
    if (redactor) {
      const schemas = [
        [modelDef.globalArguments, resolvedDefinition.globalArguments],
        [
          modelDef.methods[methodName]?.arguments,
          resolvedDefinition.getMethodArguments(methodName),
        ],
      ] as const;
      for (const [schema, values] of schemas) {
        if (!schema) continue;
        for (const secret of extractSensitiveFieldValues(schema, values)) {
          redactor.addSecret(secret);
        }
      }
    }

    return {
      definition: resolvedDefinition,
      secretBag: runtimeResult.secretBag,
    };
  }

  async #resolveByDefinition(
    options: RunModelByDefinition,
  ): Promise<ResolveResult> {
    const lookup = await findDefinitionByIdOrName(
      this.#deps.commonDeps.definitionRepository,
      options.definition,
    );
    if (!lookup) {
      return {
        ok: false,
        error: {
          message: `Definition "${options.definition}" not found.`,
        },
      };
    }

    const modelDef = await resolveModelType(
      lookup.type,
      getAutoResolver(),
    );
    if (!modelDef) {
      return wordedFailure((w) =>
        `${w.Noun} type "${lookup.type}" not found for definition "${options.definition}".`
      );
    }

    if (!modelDef.methods[options.method]) {
      return wordedFailure((w) =>
        `Method "${options.method}" not found on ${w.noun} type "${modelDef.type.normalized}".`
      );
    }

    return { ok: true, definition: lookup.definition, modelDef };
  }

  async #resolveByType(
    options: RunModelByType,
  ): Promise<ResolveResult> {
    const modelDef = await resolveModelType(
      options.modelType,
      getAutoResolver(),
    );
    if (!modelDef) {
      return wordedFailure((w) =>
        `${w.Noun} type "${options.modelType}" not found.`
      );
    }

    if (!modelDef.methods[options.method]) {
      return wordedFailure((w) =>
        `Method "${options.method}" not found on ${w.noun} type "${options.modelType}".`
      );
    }

    const definitionRepo = this.#deps.commonDeps.definitionRepository;
    const existing = await definitionRepo.findByNameGlobal(options.name);
    let definition: Definition;

    if (existing) {
      if (existing.type.normalized !== modelDef.type.normalized) {
        return {
          ok: false,
          error: {
            message:
              `Definition "${options.name}" exists but has type "${existing.type.normalized}", ` +
              `not "${modelDef.type.normalized}".`,
          },
        };
      }
      definition = existing.definition;
    } else {
      let globalArgs: Record<string, unknown> = {};
      if (options.arguments && Object.keys(options.arguments).length > 0) {
        const routed = routeArguments(
          options.arguments,
          options.method,
          modelDef,
        );
        if (!isRoutedArgs(routed)) return routed;
        const refused = refuseEvaluableGlobalArgs(
          options.name,
          routed.globalArgs,
        );
        if (refused) return refused;
        globalArgs = routed.globalArgs;
      }
      definition = Definition.create({
        name: options.name,
        type: modelDef.type.normalized,
        typeVersion: modelDef.version,
        globalArguments: globalArgs,
      });
      await definitionRepo.save(modelDef.type, definition);
      logger
        .info`Auto-created definition ${options.name} for type ${options.modelType}`;
    }

    return { ok: true, definition, modelDef };
  }

  async #checkAuthorization(
    callerContext: MethodContext,
    targetModelDef: ModelDefinition,
  ): Promise<RunModelResult | null> {
    const callerModelDef = modelRegistry.get(callerContext.modelType);
    if (!callerModelDef) return null;

    if (!callerModelDef.extensionName) return null;

    const targetType = targetModelDef.type.normalized;
    if (!ModelType.isUserNamespace(targetType)) return null;

    if (targetModelDef.extensionName === callerModelDef.extensionName) {
      return null;
    }

    const callerDeps = await this.#loadExtensionDependencies(
      callerModelDef.extensionName,
    );
    if (!callerDeps) {
      logger
        .warn`Authorization: could not load manifest for extension ${callerModelDef.extensionName} — rejecting cross-extension runModel call (fail-closed)`;
      return {
        ok: false,
        error: {
          message:
            `Cannot verify dependencies for extension "${callerModelDef.extensionName}" — ` +
            `manifest could not be loaded. Ensure the extension is properly installed.`,
        },
      };
    }

    const targetExtension = targetModelDef.extensionName;
    if (!targetExtension) return null;

    if (callerDeps.includes(targetExtension)) return null;

    const callerCollective = ModelType.getUserNamespace(
      callerModelDef.type.normalized,
    );
    const targetCollective = ModelType.getUserNamespace(targetType);
    if (
      callerCollective && targetCollective &&
      callerCollective === targetCollective
    ) {
      return null;
    }

    return wordedFailure((w) =>
      `Extension "${callerModelDef.extensionName}" cannot invoke ${w.noun} type ` +
      `"${targetType}" from extension "${targetExtension}" — add ` +
      `"${targetExtension}" to dependencies in manifest.yaml.`
    );
  }

  #manifestCache = new Map<string, string[]>();

  async #loadExtensionDependencies(
    extensionName: string,
  ): Promise<string[] | null> {
    const cached = this.#manifestCache.get(extensionName);
    if (cached) return cached;

    if (
      extensionName.includes("..") ||
      extensionName.includes("\0") ||
      extensionName.includes("\\")
    ) {
      return null;
    }

    try {
      const pulledRoot = this.#deps.pulledExtensionsRoot ?? join(
        this.#deps.repoDir,
        ".swamp",
        "pulled-extensions",
      );
      const manifestPath = join(
        pulledRoot,
        extensionName,
        "manifest.yaml",
      );
      const resolved = resolve(manifestPath);
      if (!resolved.startsWith(resolve(pulledRoot) + SEPARATOR)) {
        return null;
      }
      const content = await Deno.readTextFile(manifestPath);
      const manifest = parseExtensionManifest(content);
      this.#manifestCache.set(extensionName, manifest.dependencies);
      return manifest.dependencies;
    } catch {
      return null;
    }
  }
}
