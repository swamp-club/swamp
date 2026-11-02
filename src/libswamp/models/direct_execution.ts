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

import {
  type RunSensitiveValues,
  toPersistedForm,
  vaultReferenceText,
} from "../../domain/secrets/mod.ts";
import {
  Definition,
  definitionNameViolation,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import {
  coerceMethodArgs,
  getObjectShape,
  isRecordSchema,
  parseGlobalArgumentsLeniently,
} from "../../domain/models/zod_type_coercion.ts";
import type { ExpressionLocation } from "../../domain/expressions/expression.ts";
import {
  extractExpressions,
  readSetMap,
  rewriteExpressions,
  stripExpressionFields,
} from "../../domain/expressions/expression_parser.ts";
import {
  type DirectInputsProvenance,
  isAtOrUnder,
  keySegment,
  ProvenanceMap,
  routedGlobalProvenance,
} from "../../domain/expressions/provenance_map.ts";
import { isDeferredExpression } from "../../domain/expressions/deferred_expression.ts";
import {
  refusedOccurrenceLine,
  storedTextRefusal,
} from "../../domain/expressions/swamp_namespaces.ts";
import { literalOccurrence } from "../../domain/expressions/cel_grammar.ts";
import {
  type AuthoredExpressions,
  collectAuthoredExpressions,
} from "../../domain/expressions/expression_evaluation_service.ts";
import {
  findLiteralSensitiveGlobalArgs,
  literalSensitiveGlobalArgsMessage,
  maskRefusedIssues,
  schemaThrowMessage,
  sensitiveGlobalArgPaths,
  withheldSensitiveTextLine,
} from "../../domain/models/sensitive_field_extractor.ts";
import { DefaultModelValidationService } from "../../domain/models/validation_service.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed, wordedSwampError } from "../errors.ts";
import { wordedText } from "../../domain/behavior_wording.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import {
  observeDiagnosticPhase,
  withDiagnosticAttributes,
} from "../../domain/diagnostics/diagnostic_phase.ts";

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

/** method arguments take precedence over global arguments on ambiguous keys */
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
 * The definition as the step runs it: the stored one with the caller's
 * routed global arguments at their real values, where the store holds vault
 * references for sensitive values.
 */
function withRealGlobals(
  definition: Definition,
  routedGlobals: Record<string, unknown>,
): Definition {
  const stored = definition.globalArguments as Record<string, unknown>;
  const differs = Object.entries(routedGlobals).some(([key, value]) =>
    JSON.stringify(stored[key]) !== JSON.stringify(value)
  );
  if (!differs) return definition;
  const inMemory = Definition.fromData(definition.toData());
  for (const [key, value] of Object.entries(routedGlobals)) {
    inMemory.setGlobalArgument(key, value);
  }
  return inMemory;
}

/**
 * flattens '/' from scoped names so the lock path gets no intermediate
 * directories
 */
export function autoDefinitionLockKey(name: string): string {
  const sanitized = name.replace(/\//g, "--");
  return `.auto-definition-create/${sanitized}.lock`;
}

/**
 * short initial interval: the lock guards only a re-check and a save, so the
 * FileLock default made race losers sleep through a release that came
 * milliseconds later; matches the per-model lock interval
 */
export const AUTO_DEFINITION_LOCK_RETRY_INTERVAL_MS = 25;

export function createAutoDefinitionLock(
  lockDir: string,
  name: string,
): FileLock {
  return new FileLock(lockDir, {
    lockKey: autoDefinitionLockKey(name),
    diagnosticKind: "auto_definition",
    ttlMs: 5_000,
    maxWaitMs: 10_000,
    retryIntervalMs: AUTO_DEFINITION_LOCK_RETRY_INTERVAL_MS,
  });
}

/**
 * expressions that arrived through data substitution, not written by an author;
 * persisting them as-is would make them authored on every later load, so they
 * are wrapped in literal() or refused
 */
function findUnvouchedGlobalArgExpressions(
  globalArgs: Record<string, unknown>,
  authored: AuthoredExpressions,
): ExpressionLocation[] {
  if (authored === "unrestricted") return [];
  return extractExpressions(globalArgs).filter((e) => !authored.has(e.raw));
}

/**
 * decided by position, whatever the authored set says: the stored definition is
 * read back as authored source, so data must never reach it as expression text
 * swamp would evaluate
 */
function findDataRangeGlobalArgExpressions(
  persistedGlobal: Record<string, unknown>,
  routedGlobal: Record<string, unknown>,
  routedMap: ProvenanceMap,
  writtenReferenceTexts: ReadonlySet<string>,
): ExpressionLocation[] {
  if (routedMap.isAuthored) return [];
  // Values toPersistedForm rewrote hold swamp's own vault references; those
  // are authored where they now sit, the rest of a rewritten value is data.
  let map = routedMap;
  for (const [key, value] of Object.entries(persistedGlobal)) {
    if (
      JSON.stringify(value) === JSON.stringify(routedGlobal[key]) ||
      !map.hasDataAtOrBelow(keySegment(key))
    ) continue;
    map = map.graft(keySegment(key), readSetMap(value, writtenReferenceTexts));
  }
  return extractExpressions(persistedGlobal).filter((e) =>
    e.start === undefined || e.end === undefined
      ? map.hasDataAtOrBelow(e.path)
      : map.overlapsData(e.path, e.start, e.end)
  );
}

/**
 * another templating system's text is stored wrapped in its own literal() so
 * later loads evaluate it as data; text swamp would own is refused, as is any
 * expression text in a sensitive field, which would be stored in cleartext
 */
function storableGlobalArgs(
  globalArgs: Record<string, unknown>,
  found: ExpressionLocation[],
  sensitivePaths: readonly string[],
): { stored: Record<string, unknown>; refused: string[] } {
  if (found.length === 0) return { stored: globalArgs, refused: [] };
  const occurrenceKey = (e: ExpressionLocation) => `${e.path}\0${e.start}`;
  const unvouched = new Set(found.map(occurrenceKey));
  const refused = new Set<string>();
  const stored = rewriteExpressions(globalArgs, (e) => {
    if (!unvouched.has(occurrenceKey(e))) return undefined;
    if (sensitivePaths.some((path) => isAtOrUnder(e.path, path))) {
      refused.add(withheldSensitiveTextLine(e.path));
      return undefined;
    }
    const reason = storedTextRefusal(e.celExpression);
    if (reason === undefined) return literalOccurrence(e.raw);
    refused.add(refusedOccurrenceLine(e.path, e.raw, reason));
    return undefined;
  }) as Record<string, unknown>;
  return { stored, refused: [...refused] };
}

function unvouchedGlobalArgsMessage(
  definitionName: string,
  unvouched: string[],
): string {
  return `Refusing to persist definition '${definitionName}': the following global arguments hold expression text that was not written as an expression in the workflow or definition source (it came from data or from literal()), and it cannot be stored:\n${
    unvouched.join("\n")
  }\nA global argument stores another system's expression text as text, and refuses swamp's own expressions and any expression text in a sensitive field. Write the expression into the definition itself, or pass the value as a method argument instead of a global argument.`;
}

/**
 * shared by the lookup fast path and the locked re-check, where a caller that
 * lost the auto-creation race adopts the winner's definition and applies its
 * own global arguments
 */
function adoptExistingDefinition(
  ...args: Parameters<typeof adoptDefinition>
): Promise<DirectExecutionResult> {
  return observeDiagnosticPhase("definition_adopt", {
    "swamp.diagnostic.definition_outcome": "reused",
  }, () => adoptDefinition(...args));
}

async function adoptDefinition(
  deps: DirectExecutionDeps,
  existing: { definition: Definition; type: ModelType },
  typeArg: string,
  definitionName: string,
  resolvedType: ModelType,
  modelDef: ModelDefinition,
  routed: RoutedInputs,
  authoredExpressions: AuthoredExpressions,
  persistedGlobal: Record<string, unknown> = routed.globalArguments,
  dataRangeCheck: () => ExpressionLocation[] = () => [],
): Promise<DirectExecutionResult> {
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
  // Compared and written in persisted form, so a sensitive value read through
  // data is stored as its vault reference, text from data is compared in the
  // literal() form it is stored in, and an unchanged value causes no re-save.
  const { stored: routedGlobal, refused: unvouched } = storableGlobalArgs(
    persistedGlobal,
    [
      ...findUnvouchedGlobalArgExpressions(
        persistedGlobal,
        authoredExpressions,
      ),
      ...dataRangeCheck(),
    ],
    sensitiveGlobalArgPaths(modelDef.globalArguments, persistedGlobal),
  );
  const globalArgsDiffer = Object.keys(routedGlobal).length > 0 &&
    !Object.entries(routedGlobal).every(([k, v]) =>
      JSON.stringify(storedGlobal?.[k]) === JSON.stringify(v)
    );

  if (globalArgsDiffer) {
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
  }
  // checked even when the globals did not change, since a hand-edited
  // definition skips the save-time refusal; checks the persisted form after its
  // upgrade chain, never real values, which may hold plaintext
  const leakedArgs = new DefaultModelValidationService()
    .findLiteralSensitiveGlobals(existing.definition, modelDef);
  if (leakedArgs.length > 0) {
    return {
      ok: false,
      error: validationFailed(
        literalSensitiveGlobalArgsMessage(leakedArgs),
      ),
    };
  }
  if (globalArgsDiffer) {
    await deps.saveDefinition(existing.type, existing.definition);
  }

  return {
    ok: true,
    definition: withRealGlobals(existing.definition, routed.globalArguments),
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

/**
 * authoredExpressions is the provenance of the inputs: unrestricted when an
 * operator typed them, else the workflow source's set; expressions outside it
 * are refused, not persisted
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
  sensitiveValues?: RunSensitiveValues,
  provenance?: DirectInputsProvenance,
): Promise<DirectExecutionResult> {
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

  // Global arguments as they are written: a sensitive value read through
  // data becomes the vault reference it came from. Those references are
  // swamp's own text, so they are vouched for alongside the authored set.
  const persisted = sensitiveValues
    ? toPersistedForm(routed.globalArguments, sensitiveValues)
    : { data: routed.globalArguments, writtenReferences: [] };
  const persistedGlobal = persisted.data;
  const vouched: AuthoredExpressions = authoredExpressions === "unrestricted"
    ? authoredExpressions
    : new Set([
      ...authoredExpressions,
      ...persisted.writtenReferences.map((ref) => vaultReferenceText(ref)),
    ]);

  const routedMap = provenance
    ? routedGlobalProvenance(
      routed.globalArguments,
      explicitGlobalArgs ?? inputs,
      explicitGlobalArgs ? provenance.globalArgs : provenance.inputs,
    )
    : ProvenanceMap.authored();
  const writtenReferenceTexts = new Set(
    persisted.writtenReferences.map((ref) => vaultReferenceText(ref)),
  );
  const dataRangeCheck = () =>
    findDataRangeGlobalArgExpressions(
      persistedGlobal,
      routed.globalArguments,
      routedMap,
      writtenReferenceTexts,
    );

  const existing = await withDiagnosticAttributes(
    { "swamp.diagnostic.lookup_attempt": "initial" },
    () => deps.lookupDefinition(definitionName),
  );

  if (existing) {
    return await adoptExistingDefinition(
      deps,
      existing,
      typeArg,
      definitionName,
      resolvedType,
      modelDef,
      routed,
      vouched,
      persistedGlobal,
      dataRangeCheck,
    );
  }

  // Only a new definition must meet the naming rule; an existing one whose
  // name predates it was adopted above and stays runnable.
  const nameViolation = definitionNameViolation(definitionName);
  if (nameViolation) {
    return {
      ok: false,
      error: wordedSwampError(
        "validation_failed",
        wordedText((w) =>
          `Invalid ${w.noun} name: ${definitionName}. ${nameViolation}`
        ),
      ),
    };
  }

  // validate provided global arguments but not missing ones: direct execution
  // creates ephemeral instances, and the cloud API enforces required fields at
  // call time for methods that need them
  if (modelDef.globalArguments) {
    // Validate only static fields: expression fields resolve at runtime and a
    // sentinel would fail constrained schemas; stripped keys are passed as
    // skipped.
    const staticArgs = stripExpressionFields(routed.globalArguments);
    const strippedKeys = new Set(
      Object.keys(routed.globalArguments).filter((key) =>
        !Object.hasOwn(staticArgs, key)
      ),
    );
    // described as a run's refusal is, so the schema's own code cannot spell a
    // sensitive value, and a schema that throws while parsing is reported as a
    // run reports it
    const globalArgsSchema = modelDef.globalArguments;
    let result: ReturnType<typeof parseGlobalArgumentsLeniently>;
    try {
      result = parseGlobalArgumentsLeniently(
        globalArgsSchema,
        staticArgs,
        strippedKeys,
      );
    } catch (error) {
      return {
        ok: false,
        error: validationFailed(
          `Invalid global arguments for type '${resolvedType.normalized}': ${
            schemaThrowMessage(error, globalArgsSchema, "Global arguments")
          }`,
        ),
      };
    }
    if (!result.success) {
      const issues = maskRefusedIssues(
        globalArgsSchema,
        staticArgs,
        result.issues,
      ).map((i) => {
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

  // refuse a literal sensitive global argument before persisting it in
  // cleartext; the persistence chokepoint enforces this too, but checking here
  // gives a typed error. Expression values pass
  const leakedArgs = findLiteralSensitiveGlobalArgs(
    modelDef.globalArguments,
    persistedGlobal,
  );
  if (leakedArgs.length > 0) {
    return {
      ok: false,
      error: validationFailed(literalSensitiveGlobalArgsMessage(leakedArgs)),
    };
  }
  const { stored: storedGlobal, refused: unvouched } = storableGlobalArgs(
    persistedGlobal,
    [
      ...findUnvouchedGlobalArgExpressions(persistedGlobal, vouched),
      ...dataRangeCheck(),
    ],
    sensitiveGlobalArgPaths(modelDef.globalArguments, persistedGlobal),
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
      globalArguments: storedGlobal,
    });
    await observeDiagnosticPhase("definition_save", {
      "swamp.diagnostic.definition_outcome": "created",
    }, () => deps.saveDefinition(resolvedType, definition));
    return {
      ok: true,
      definition: withRealGlobals(definition, routed.globalArguments),
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
    const lock = createAutoDefinitionLock(lockDir, definitionName);
    try {
      return await lock.withLock(async () => {
        // Re-check under lock — race losers adopt the winner's definition,
        // then apply their own global arguments to it: forEach iterations
        // sharing one modelName can each pass different globalArgs, so a
        // loser must not run with the winner's.
        const raceWinner = await withDiagnosticAttributes(
          { "swamp.diagnostic.lookup_attempt": "recheck" },
          () => deps.lookupDefinition(definitionName),
        );
        if (raceWinner) {
          return await adoptExistingDefinition(
            deps,
            raceWinner,
            typeArg,
            definitionName,
            resolvedType,
            modelDef,
            routed,
            // Compared and stored in persisted form, as on the fast path, so
            // the occurrences dataRangeCheck finds are positions in the value
            // that is stored.
            vouched,
            persistedGlobal,
            dataRangeCheck,
          );
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
