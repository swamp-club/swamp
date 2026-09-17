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

import type { z } from "zod";
import { Definition } from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import {
  coerceMethodArgs,
  getObjectShape,
  isRecordSchema,
} from "../../domain/models/zod_type_coercion.ts";
import type { ExpressionLocation } from "../../domain/expressions/expression.ts";
import {
  extractExpressions,
  stripExpressionFields,
} from "../../domain/expressions/expression_parser.ts";
import { isDeferredExpression } from "../../domain/expressions/deferred_expression.ts";
import {
  type AuthoredExpressions,
  collectAuthoredExpressions,
} from "../../domain/expressions/expression_evaluation_service.ts";
import {
  findLiteralSensitiveGlobalArgs,
  literalSensitiveGlobalArgsMessage,
} from "../../domain/models/sensitive_field_extractor.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";

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
    globalArgsUpdated?: boolean;
    /**
     * Raw text of every expression in the definition as it was stored on
     * disk, before any caller-supplied global arguments were applied. Empty
     * for a freshly created definition, which is synthesised from inputs.
     */
    authoredExpressions: ReadonlySet<string>;
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
  const methodIsRecord = isRecordSchema(method.arguments);
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
    } else if (methodIsRecord) {
      methodArguments[key] = value;
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
 * Lock key for serializing concurrent auto-creation of the same definition name.
 * Flattens '/' from scoped names (e.g. @collective/name) to avoid creating
 * intermediate directories in the lock path.
 */
export function autoDefinitionLockKey(name: string): string {
  const sanitized = name.replace(/\//g, "--");
  return `.auto-definition-create/${sanitized}.lock`;
}

/**
 * Expressions in the global arguments the caller cannot vouch for: text that
 * arrived through data substitution rather than being written by an author.
 * Persisting such text would turn it into an authored expression on every
 * later load of the definition, so it is refused before any save.
 */
function findUnvouchedGlobalArgExpressions(
  globalArgs: Record<string, unknown>,
  authored: AuthoredExpressions,
): ExpressionLocation[] {
  if (authored === "unrestricted") return [];
  return extractExpressions(globalArgs).filter((e) => !authored.has(e.raw));
}

function unvouchedGlobalArgsMessage(
  definitionName: string,
  unvouched: ExpressionLocation[],
): string {
  const list = unvouched.map((e) => `  ${e.path}: ${e.raw}`).join("\n");
  return `Refusing to persist definition '${definitionName}': the following global arguments hold expression text that was not written in the workflow or definition source, so it arrived as data content:\n${list}`;
}

/**
 * Resolves an existing definition by name or auto-creates one.
 * When the definition exists, verifies the type matches.
 *
 * `authoredExpressions` is the caller's provenance for `inputs` and
 * `explicitGlobalArgs`: `"unrestricted"` when an operator typed them, or the
 * workflow source's set when they have been through CEL substitution. Global
 * arguments holding expression text outside that set are refused rather than
 * persisted, so a stored definition only ever contains authored expressions.
 *
 * When `lockDir` is provided, concurrent auto-creation of the same name is
 * serialized with a file lock (double-check locking): the fast-path lookup
 * runs without a lock; only when the definition is missing does the lock
 * acquire, re-check, and create.
 */
export async function resolveOrCreateDefinition(
  deps: DirectExecutionDeps,
  typeArg: string,
  definitionName: string,
  methodName: string,
  inputs: Record<string, unknown>,
  resolvedType: ModelType,
  modelDef: ModelDefinition,
  explicitGlobalArgs?: Record<string, unknown>,
  lockDir?: string,
  authoredExpressions: AuthoredExpressions = "unrestricted",
): Promise<DirectExecutionResult> {
  // When explicit globalArgs are provided, skip routing — treat inputs as
  // method args only and use the explicit values as global args.
  let routed: RoutedInputs;
  if (explicitGlobalArgs) {
    const method = modelDef.methods[methodName];
    if (!method) {
      return {
        ok: false,
        error: {
          code: "unknown_method",
          message: `Unknown method '${methodName}'. Available methods: ${
            Object.keys(modelDef.methods).join(", ") || "none"
          }`,
        },
      };
    }
    const globalArgs = { ...explicitGlobalArgs };
    if (modelDef.globalArguments) {
      const coerced = coerceMethodArgs(
        globalArgs,
        modelDef.globalArguments,
      );
      Object.assign(globalArgs, coerced);
    }
    routed = {
      globalArguments: globalArgs,
      methodArguments: inputs,
    };
  } else {
    const routeResult = routeInputsBySchema(inputs, methodName, modelDef);
    if ("error" in routeResult) {
      return { ok: false, error: routeResult.error };
    }
    routed = routeResult;
  }

  // A parent-scoped runtime expression only resolves against the run that
  // passed it in, so it can never live in a persisted definition.
  const scoped = extractExpressions(routed.globalArguments).filter((e) =>
    isDeferredExpression(e.celExpression)
  );
  if (scoped.length > 0) {
    return {
      ok: false,
      error: validationFailed(
        `Refusing to persist definition '${definitionName}': global argument(s) ${
          scoped.map((e) => e.path).join(", ")
        } hold a runtime expression scoped to the calling workflow run (it reads the parent's inputs, self, run or steps), which cannot be stored in a definition. Pass a literal value, or an expression that does not read parent scope.`,
      ),
    };
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

    const storedExpressions = collectAuthoredExpressions(
      existing.definition.toData(),
    );
    const storedGlobal = existing.definition
      .globalArguments as Record<string, unknown>;
    const routedGlobal = routed.globalArguments;
    const globalArgsDiffer = Object.keys(routedGlobal).length > 0 &&
      !Object.entries(routedGlobal).every(([k, v]) =>
        JSON.stringify(storedGlobal?.[k]) === JSON.stringify(v)
      );

    if (globalArgsDiffer) {
      const unvouched = findUnvouchedGlobalArgExpressions(
        routedGlobal,
        authoredExpressions,
      );
      if (unvouched.length > 0) {
        return {
          ok: false,
          error: validationFailed(
            unvouchedGlobalArgsMessage(definitionName, unvouched),
          ),
        };
      }
      for (const key of Object.keys(storedGlobal ?? {})) {
        if (!(key in routedGlobal)) {
          existing.definition.removeGlobalArgument(key);
        }
      }
      for (const [key, value] of Object.entries(routedGlobal)) {
        existing.definition.setGlobalArgument(key, value);
      }
      const leakedArgs = findLiteralSensitiveGlobalArgs(
        modelDef.globalArguments,
        existing.definition.globalArguments,
      );
      if (leakedArgs.length > 0) {
        return {
          ok: false,
          error: validationFailed(
            literalSensitiveGlobalArgsMessage(leakedArgs),
          ),
        };
      }
      await deps.saveDefinition(existing.type, existing.definition);
    }

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
      globalArgsUpdated: globalArgsDiffer,
      authoredExpressions: storedExpressions,
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
    // Validate only the static fields. Fields holding a `${{ ... }}` expression
    // (e.g. a `vault.get(...)` reference) are resolved and validated at runtime;
    // checking them now would reject a sentinel string against a constrained
    // field, blocking the vault remediation for a sensitive argument.
    const staticArgs = stripExpressionFields(routed.globalArguments);
    const result = lenient.safeParse(staticArgs);
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

  // Refuse a literal value for a sensitive global argument before persisting it
  // in cleartext (enforced for every writer at the persistence chokepoint; done
  // here too for a clean, typed error). Expression values (vault.get) pass.
  const leakedArgs = findLiteralSensitiveGlobalArgs(
    modelDef.globalArguments,
    routed.globalArguments,
  );
  if (leakedArgs.length > 0) {
    return {
      ok: false,
      error: validationFailed(literalSensitiveGlobalArgsMessage(leakedArgs)),
    };
  }
  const unvouched = findUnvouchedGlobalArgExpressions(
    routed.globalArguments,
    authoredExpressions,
  );
  if (unvouched.length > 0) {
    return {
      ok: false,
      error: validationFailed(
        unvouchedGlobalArgsMessage(definitionName, unvouched),
      ),
    };
  }

  const createResult = async (): Promise<DirectExecutionResult> => {
    const definition = Definition.create({
      name: definitionName,
      type: resolvedType.normalized,
      typeVersion: modelDef.version,
      globalArguments: routed.globalArguments,
    });
    await deps.saveDefinition(resolvedType, definition);
    return {
      ok: true,
      definition,
      modelType: resolvedType,
      modelDef,
      created: true,
      definitionPath: deps.getDefinitionPath(resolvedType, definition.id),
      routedInputs: routed,
      authoredExpressions: new Set(),
    };
  };

  // Serialize auto-creation with a name-based file lock so concurrent
  // processes converge on a single definition instead of creating duplicates.
  if (lockDir) {
    const lock = new FileLock(lockDir, {
      lockKey: autoDefinitionLockKey(definitionName),
      ttlMs: 5_000,
      maxWaitMs: 10_000,
    });
    try {
      return await lock.withLock(async () => {
        // Re-check under lock — race losers adopt the winner's definition.
        // Global-args reconciliation is skipped here: concurrent auto-creators
        // share the same input line, so args are identical.
        const raceWinner = await deps.lookupDefinition(definitionName);
        if (raceWinner) {
          if (raceWinner.type.normalized !== resolvedType.normalized) {
            return {
              ok: false,
              error: validationFailed(
                `Definition '${definitionName}' exists with type '${raceWinner.type.normalized}' ` +
                  `but '${typeArg}' resolves to '${resolvedType.normalized}'. ` +
                  `Type mismatch — delete the existing definition or use a different name.`,
              ),
            };
          }
          return {
            ok: true,
            definition: raceWinner.definition,
            modelType: raceWinner.type,
            modelDef,
            created: false,
            definitionPath: deps.getDefinitionPath(
              raceWinner.type,
              raceWinner.definition.id,
            ),
            routedInputs: routed,
            authoredExpressions: collectAuthoredExpressions(
              raceWinner.definition.toData(),
            ),
          };
        }
        return await createResult();
      });
    } catch (e) {
      if (e instanceof LockTimeoutError) {
        return {
          ok: false,
          error: {
            code: "lock_timeout",
            message:
              `Timed out waiting for auto-definition lock on '${definitionName}'. ` +
              `Another process may be creating this definition.`,
          },
        };
      }
      throw e;
    }
  }

  return await createResult();
}
