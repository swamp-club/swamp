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
  Definition,
  definitionNameViolation,
} from "../../domain/definitions/definition.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed, wordedSwampError } from "../errors.ts";
import { wordedText } from "../../domain/behavior_wording.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../types/schema_helpers.ts";
import {
  coerceMethodArgs,
  getObjectShape,
} from "../../domain/models/zod_type_coercion.ts";
import { stripExpressionFields } from "../../domain/expressions/expression_parser.ts";
import {
  findLiteralSensitiveGlobalArgs,
  literalSensitiveGlobalArgsMessage,
  maskRefusedIssues,
  schemaThrowMessage,
} from "../../domain/models/sensitive_field_extractor.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { argumentParseContext } from "../../domain/untrusted_parse.ts";
export interface ModelCreateData {
  id: string;
  type: string;
  name: string;
  path: string;
  version?: string;
  globalArguments?: object;
  methods?: MethodDescribeData[];
}

export type ModelCreateEvent =
  | { kind: "creating" }
  | { kind: "completed"; data: ModelCreateData }
  | { kind: "error"; error: SwampError };

export interface ModelCreateInput {
  typeArg: string;
  name: string;
  globalArguments?: Record<string, unknown>;
  /**
   * The principal that sent the request, as `kind:id`. It is recorded on the
   * span as `auth.principal.id` and is never used to authorize the create.
   */
  principalId?: string;
}

export interface ModelCreateDeps {
  resolveModelType: (
    typeArg: string,
  ) => Promise<ModelDefinition | undefined>;
  findByNameGlobal: (name: string) => Promise<boolean>;
  getModelDef: (type: ModelType) => ModelDefinition | undefined;
  createAndSave: (
    type: ModelType,
    name: string,
    typeVersion: string | undefined,
    globalArguments: Record<string, unknown> | undefined,
  ) => Promise<Definition>;
  getPath: (type: ModelType, id: DefinitionId) => string;
  listAvailableTypes: () => string[];
}

export async function createModelCreateDeps(
  repoDir: string,
  definitionsDir?: string,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): Promise<ModelCreateDeps> {
  await modelRegistry.ensureLoaded();
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(
      repoDir,
      undefined,
      definitionsDir,
    );
  return {
    resolveModelType: (typeArg) => {
      const modelType = ModelType.create(typeArg);
      return resolveModelType(modelType, getAutoResolver());
    },
    findByNameGlobal: async (name) => {
      const existing = await definitionRepo.findByNameGlobal(name);
      return existing !== null;
    },
    getModelDef: (type) => modelRegistry.get(type),
    createAndSave: async (type, name, typeVersion, globalArguments) => {
      const definition = Definition.create({
        name,
        type: type.normalized,
        typeVersion,
        globalArguments,
      });
      await definitionRepo.save(type, definition);
      return definition;
    },
    getPath: (type, id) => definitionRepo.getPath(type, id),
    listAvailableTypes: () =>
      modelRegistry.publicTypes().map((t) => t.normalized),
  };
}

export async function* modelCreate(
  ctx: LibSwampContext,
  deps: ModelCreateDeps,
  input: ModelCreateInput,
): AsyncIterable<ModelCreateEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.model.create",
      {
        "model.type": input.typeArg,
        "model.name": input.name,
        ...(input.principalId
          ? { "auth.principal.id": input.principalId }
          : {}),
      },
      (async function* () {
        yield { kind: "creating" };

        ctx.logger
          .debug`Creating model: type=${input.typeArg}, name=${input.name}`;

        // Validate the name before type resolution, which can auto-install an
        // extension, so a create that would fail does no network work.
        const nameViolation = definitionNameViolation(input.name);
        if (nameViolation) {
          yield {
            kind: "error",
            error: wordedSwampError(
              "validation_failed",
              wordedText((w) =>
                `Invalid ${w.noun} name: ${input.name}. ${nameViolation}`
              ),
            ),
          };
          return;
        }

        const modelType = ModelType.create(input.typeArg);
        const resolvedDef = await deps.resolveModelType(input.typeArg);
        if (!resolvedDef) {
          const availableTypes = deps.listAvailableTypes().join(", ");
          yield {
            kind: "error",
            error: wordedSwampError(
              "validation_failed",
              wordedText((w) =>
                `Unknown ${w.noun} type: ${input.typeArg}. Available types: ${
                  availableTypes || "none"
                }`
              ),
            ),
          };
          return;
        }

        const exists = await deps.findByNameGlobal(input.name);
        if (exists) {
          yield {
            kind: "error",
            error: wordedSwampError(
              "already_exists",
              wordedText((w) => `${w.Noun} already exists: ${input.name}`),
              { entityType: "Model", name: input.name },
            ),
          };
          return;
        }

        const modelDef = deps.getModelDef(modelType);
        let globalArguments = input.globalArguments;
        if (globalArguments && modelDef?.globalArguments) {
          globalArguments = coerceMethodArgs(
            globalArguments,
            modelDef.globalArguments,
          );
          const globalArgsSchema = modelDef.globalArguments;
          const shape = getObjectShape(globalArgsSchema);
          if (shape) {
            const unknownKeys = Object.keys(globalArguments).filter(
              (k) => !Object.hasOwn(shape, k),
            );
            if (unknownKeys.length > 0) {
              const validKeys = Object.keys(shape).join(", ");
              yield {
                kind: "error",
                error: validationFailed(
                  `Unknown global argument(s) for type '${modelType.normalized}': ${
                    unknownKeys.join(", ")
                  }. Valid arguments are: ${validKeys || "none"}`,
                ),
              };
              return;
            }
          }
          // validate only static fields: `${{ }}` expression fields resolve at
          // runtime, and a sentinel string would fail constrained schemas (e.g.
          // min(20)), making the vault remediation impossible
          const staticArgs = stripExpressionFields(globalArguments);
          const hasExpressionArgs = Object.keys(staticArgs).length <
            Object.keys(globalArguments).length;
          if (!hasExpressionArgs) {
            // described as a run's refusal is, so the schema's own code cannot
            // spell a sensitive value, and a schema that throws while parsing
            // is reported as a run reports it
            let result: ReturnType<typeof globalArgsSchema.safeParse>;
            try {
              result = globalArgsSchema.safeParse(
                globalArguments,
                argumentParseContext(),
              );
            } catch (error) {
              yield {
                kind: "error",
                error: validationFailed(
                  `Invalid global arguments for type '${modelType.normalized}': ${
                    schemaThrowMessage(
                      error,
                      globalArgsSchema,
                      "Global arguments",
                    )
                  }`,
                ),
              };
              return;
            }
            if (!result.success) {
              const issues = maskRefusedIssues(
                globalArgsSchema,
                globalArguments,
                result.error.issues,
              ).map((i) => {
                const path = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
                return `  ${path}${i.message}`;
              }).join("\n");
              yield {
                kind: "error",
                error: validationFailed(
                  `Invalid global arguments for type '${modelType.normalized}':\n${issues}`,
                ),
              };
              return;
            }
            globalArguments = result.data as Record<string, unknown>;
          }

          // refuse a literal sensitive global argument before it is persisted
          // in cleartext; the repository save enforces this too, but checking
          // here gives a typed error. Expressions pass through
          const leakedArgs = findLiteralSensitiveGlobalArgs(
            modelDef.globalArguments,
            globalArguments,
          );
          if (leakedArgs.length > 0) {
            yield {
              kind: "error",
              error: validationFailed(
                literalSensitiveGlobalArgsMessage(leakedArgs),
              ),
            };
            return;
          }
        }

        const definition = await deps.createAndSave(
          modelType,
          input.name,
          modelDef?.version,
          globalArguments,
        );

        ctx.logger.debug`Created definition with ID: ${definition.id}`;

        const data: ModelCreateData = {
          id: definition.id,
          type: modelType.normalized,
          name: definition.name,
          path: deps.getPath(modelType, definition.id),
          version: modelDef?.version,
          globalArguments: modelDef?.globalArguments
            ? zodToJsonSchema(modelDef.globalArguments)
            : undefined,
          methods: modelDef
            ? Object.entries(modelDef.methods).map(
              ([name, method]) => toMethodDescribeData(name, method),
            )
            : undefined,
        };

        yield { kind: "completed", data };
      })(),
    ));
}
