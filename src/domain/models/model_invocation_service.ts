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

const MAX_INVOCATION_DEPTH = 10;
const MAX_INVOCATION_BREADTH = 100;

const logger = getLogger(["swamp", "model", "invocation"]);

export interface ModelInvocationServiceDeps {
  executionService: MethodExecutionService;
  commonDeps: CommonMethodContextDeps;
  repoDir: string;
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
    return {
      ok: false,
      error: {
        message:
          `Method "${methodName}" not found on model type "${modelDef.type.normalized}".`,
      },
    };
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

export class ModelInvocationService {
  readonly #deps: ModelInvocationServiceDeps;

  constructor(deps: ModelInvocationServiceDeps) {
    this.#deps = deps;
  }

  async invoke(
    options: RunModelOptions,
    callerContext: MethodContext,
  ): Promise<RunModelResult> {
    const tracking = callerContext._invocationTracking ?? {
      depth: 0,
      ancestors: new Set<string>(),
      breadthCounter: { count: 0 },
    };

    if (tracking.depth >= MAX_INVOCATION_DEPTH) {
      return {
        ok: false,
        error: {
          message:
            `Maximum cross-model invocation depth (${MAX_INVOCATION_DEPTH}) exceeded. ` +
            `Check for deep nesting chains in your runModel calls.`,
        },
      };
    }

    tracking.breadthCounter.count++;
    if (tracking.breadthCounter.count > MAX_INVOCATION_BREADTH) {
      return {
        ok: false,
        error: {
          message:
            `Maximum cross-model invocation count (${MAX_INVOCATION_BREADTH}) exceeded ` +
            `in this execution. Reduce the number of runModel calls.`,
        },
      };
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

    let childDefinition = definition;
    let mergedGlobalArgs = definition.globalArguments ?? {};

    if (options.arguments && Object.keys(options.arguments).length > 0) {
      const routed = routeArguments(options.arguments, methodName, modelDef);
      if (!isRoutedArgs(routed)) return routed;

      childDefinition = Definition.fromData(definition.toData());
      for (const [key, value] of Object.entries(routed.methodArgs)) {
        childDefinition.setMethodArgument(methodName, key, value);
      }
      mergedGlobalArgs = {
        ...definition.globalArguments,
        ...routed.globalArgs,
      };
    }

    const childContext = buildMethodContext(
      this.#deps.commonDeps,
      {
        signal: callerContext.signal,
        repoDir: this.#deps.repoDir,
        modelType: modelDef.type,
        modelId: childDefinition.id,
        globalArgs: mergedGlobalArgs,
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
      return {
        ok: false,
        error: {
          message:
            `Model type "${lookup.type}" not found for definition "${options.definition}".`,
        },
      };
    }

    if (!modelDef.methods[options.method]) {
      return {
        ok: false,
        error: {
          message:
            `Method "${options.method}" not found on model type "${modelDef.type.normalized}".`,
        },
      };
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
      return {
        ok: false,
        error: {
          message: `Model type "${options.modelType}" not found.`,
        },
      };
    }

    if (!modelDef.methods[options.method]) {
      return {
        ok: false,
        error: {
          message:
            `Method "${options.method}" not found on model type "${options.modelType}".`,
        },
      };
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

    return {
      ok: false,
      error: {
        message:
          `Extension "${callerModelDef.extensionName}" cannot invoke model type ` +
          `"${targetType}" from extension "${targetExtension}" — add ` +
          `"${targetExtension}" to dependencies in manifest.yaml.`,
      },
    };
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
      const pulledRoot = join(
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
