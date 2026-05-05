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

import { Definition } from "../../domain/definitions/definition.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { alreadyExists, validationFailed } from "../errors.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../types/schema_helpers.ts";
import { coerceInputTypes } from "../../domain/inputs/mod.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the model create output.
 */
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

/** Input for the model create operation. */
export interface ModelCreateInput {
  typeArg: string;
  name: string;
  globalArguments?: Record<string, unknown>;
}

/** Dependencies for the model create operation. */
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

/** Wires real infrastructure into ModelCreateDeps. */
export async function createModelCreateDeps(
  repoDir: string,
): Promise<ModelCreateDeps> {
  await modelRegistry.ensureLoaded();
  const definitionRepo = new YamlDefinitionRepository(repoDir);
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
    listAvailableTypes: () => modelRegistry.types().map((t) => t.normalized),
  };
}

/** Creates a new model definition. */
export async function* modelCreate(
  ctx: LibSwampContext,
  deps: ModelCreateDeps,
  input: ModelCreateInput,
): AsyncIterable<ModelCreateEvent> {
  yield* withGeneratorSpan(
    "swamp.model.create",
    { "model.type": input.typeArg, "model.name": input.name },
    (async function* () {
      yield { kind: "creating" };

      ctx.logger
        .debug`Creating model: type=${input.typeArg}, name=${input.name}`;

      // Validate and resolve the model type
      const modelType = ModelType.create(input.typeArg);
      const resolvedDef = await deps.resolveModelType(input.typeArg);
      if (!resolvedDef) {
        const availableTypes = deps.listAvailableTypes().join(", ");
        yield {
          kind: "error",
          error: validationFailed(
            `Unknown model type: ${input.typeArg}. Available types: ${
              availableTypes || "none"
            }`,
          ),
        };
        return;
      }

      // Check name uniqueness
      const exists = await deps.findByNameGlobal(input.name);
      if (exists) {
        yield {
          kind: "error",
          error: alreadyExists("Model", input.name),
        };
        return;
      }

      // Validate global arguments against model schema if present
      const modelDef = deps.getModelDef(modelType);
      let globalArguments = input.globalArguments;
      if (globalArguments && modelDef?.globalArguments) {
        // Coerce CLI string values to match schema types (e.g. "428" → 428)
        const jsonSchema = zodToJsonSchema(modelDef.globalArguments);
        globalArguments = coerceInputTypes(
          globalArguments,
          jsonSchema as Record<string, unknown>,
        );
        const globalArgsSchema = modelDef.globalArguments;
        const strictGlobalArgs = (
          globalArgsSchema as unknown as {
            strict?(): typeof globalArgsSchema;
          }
        ).strict?.() ?? globalArgsSchema;
        const result = strictGlobalArgs.safeParse(globalArguments);
        if (!result.success) {
          const issues = result.error.issues.map((i) =>
            `  ${i.path.join(".")}: ${i.message}`
          ).join("\n");
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

      // Create and save the definition
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
            ([name, method]) =>
              toMethodDescribeData(
                name,
                method,
                modelDef.resources,
                modelDef.files,
              ),
          )
          : undefined,
      };

      yield { kind: "completed", data };
    })(),
  );
}
