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

import type { z } from "zod";
import { Definition } from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import {
  coerceMethodArgs,
  getObjectShape,
} from "../../domain/models/zod_type_coercion.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";

export interface DirectExecutionDeps {
  lookupDefinition: (
    name: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
  saveDefinition: (type: ModelType, definition: Definition) => Promise<void>;
  getDefinitionPath: (type: ModelType, id: string) => string;
}

export interface RoutedInputs {
  globalArguments: Record<string, unknown>;
  methodArguments: Record<string, unknown>;
}

export type DirectExecutionResult =
  | {
    ok: true;
    definition: Definition;
    modelType: ModelType;
    modelDef: ModelDefinition;
    created: boolean;
    definitionPath: string;
    routedInputs: RoutedInputs;
    globalArgsDiffer?: boolean;
  }
  | { ok: false; error: SwampError };

/**
 * Routes input values between globalArguments and method arguments using
 * the type's Zod schemas. Method arguments take precedence on ambiguous keys.
 */
export function routeInputsBySchema(
  inputs: Record<string, unknown>,
  methodName: string,
  modelDef: ModelDefinition,
): RoutedInputs | { error: SwampError } {
  const method = modelDef.methods[methodName];
  if (!method) {
    return {
      error: {
        code: "unknown_method",
        message: `Unknown method '${methodName}'. Available methods: ${
          Object.keys(modelDef.methods).join(", ") || "none"
        }`,
      },
    };
  }

  const methodShape = getObjectShape(method.arguments);
  const globalShape = modelDef.globalArguments
    ? getObjectShape(modelDef.globalArguments)
    : null;

  const methodKeys = methodShape ? new Set(Object.keys(methodShape)) : new Set<
    string
  >();
  const globalKeys = globalShape
    ? new Set(Object.keys(globalShape))
    : new Set<string>();

  const globalArguments: Record<string, unknown> = {};
  const methodArguments: Record<string, unknown> = {};
  const unknownKeys: string[] = [];

  for (const [key, value] of Object.entries(inputs)) {
    if (methodKeys.has(key)) {
      methodArguments[key] = value;
    } else if (globalKeys.has(key)) {
      globalArguments[key] = value;
    } else {
      unknownKeys.push(key);
    }
  }

  if (unknownKeys.length > 0) {
    const allValid = [...methodKeys, ...globalKeys];
    return {
      error: validationFailed(
        `Unknown input(s): ${unknownKeys.join(", ")}. ` +
          `Valid inputs are: ${allValid.join(", ") || "none"}`,
      ),
    };
  }

  if (modelDef.globalArguments) {
    const coerced = coerceMethodArgs(
      globalArguments,
      modelDef.globalArguments,
    );
    Object.assign(globalArguments, coerced);
  }

  return { globalArguments, methodArguments };
}

/**
 * Resolves an existing definition by name or auto-creates one.
 * When the definition exists, verifies the type matches.
 */
export async function resolveOrCreateDefinition(
  deps: DirectExecutionDeps,
  typeArg: string,
  definitionName: string,
  methodName: string,
  inputs: Record<string, unknown>,
  resolvedType: ModelType,
  modelDef: ModelDefinition,
): Promise<DirectExecutionResult> {
  // Route inputs
  const routed = routeInputsBySchema(inputs, methodName, modelDef);
  if ("error" in routed) {
    return { ok: false, error: routed.error };
  }

  // Look up existing definition
  const existing = await deps.lookupDefinition(definitionName);

  if (existing) {
    // Verify type matches
    if (existing.type.normalized !== resolvedType.normalized) {
      return {
        ok: false,
        error: validationFailed(
          `Definition '${definitionName}' exists with type '${existing.type.normalized}' ` +
            `but '${typeArg}' resolves to '${resolvedType.normalized}'. ` +
            `Type mismatch — delete the existing definition or use a different name.`,
        ),
      };
    }

    const storedGlobal = existing.definition
      .globalArguments as Record<string, unknown>;
    const routedGlobal = routed.globalArguments;
    const globalArgsDiffer = Object.keys(routedGlobal).length > 0 &&
      !Object.entries(routedGlobal).every(([k, v]) =>
        JSON.stringify(storedGlobal?.[k]) === JSON.stringify(v)
      );

    return {
      ok: true,
      definition: existing.definition,
      modelType: existing.type,
      modelDef,
      created: false,
      definitionPath: deps.getDefinitionPath(
        existing.type,
        existing.definition.id,
      ),
      routedInputs: routed,
      globalArgsDiffer,
    };
  }

  // Validate provided global arguments but don't require missing ones.
  // Direct execution creates ephemeral instances — methods like get/sync/delete
  // don't need creation-time fields, and the cloud API enforces required-ness
  // at call time for methods that do (create/update).
  if (modelDef.globalArguments) {
    const schema = modelDef.globalArguments;
    const lenient = "partial" in schema && typeof schema.partial === "function"
      ? (schema.partial() as z.ZodTypeAny)
      : schema;
    const result = lenient.safeParse(routed.globalArguments);
    if (!result.success) {
      const issues = result.error.issues.map((i: z.ZodIssue) => {
        const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
        return `  ${path}${i.message}`;
      }).join("\n");
      return {
        ok: false,
        error: validationFailed(
          `Invalid global arguments for type '${resolvedType.normalized}':\n${issues}`,
        ),
      };
    }
  }

  // Auto-create the definition
  const definition = Definition.create({
    name: definitionName,
    type: resolvedType.normalized,
    typeVersion: modelDef.version,
    globalArguments: routed.globalArguments,
  });

  await deps.saveDefinition(resolvedType, definition);

  const definitionPath = deps.getDefinitionPath(resolvedType, definition.id);

  return {
    ok: true,
    definition,
    modelType: resolvedType,
    modelDef,
    created: true,
    definitionPath,
    routedInputs: routed,
  };
}
