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

import type { Definition } from "../../domain/definitions/definition.ts";
import {
  resolveStaleness,
  type StalenessState,
} from "../../domain/definitions/definition_staleness.ts";
export type { StalenessState };
import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  type DefinitionLookupResult,
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { redactSensitiveValues } from "../../domain/models/sensitive_field_extractor.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { behaviorNotFound } from "../errors.ts";
import { type LookupOptions, selectLookup } from "../lookup_by_id.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../types/schema_helpers.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface ModelGetData {
  id: string;
  name: string;
  description?: string;
  type: string;
  version: number;
  tags: Record<string, string>;
  globalArguments: Record<string, unknown>;
  autoCreated?: boolean;
  /**
   * the type version this definition's global arguments were authored or
   * migrated for, as recorded in the definition; absent when it records none,
   * in which case the upgrade chain does not run
   */
  typeVersion?: string;
  currentTypeVersion?: string;
  staleness?: StalenessState;
  globalArgumentsSchema?: object;
  methods?: MethodDescribeData[];
  configuredMethods?: Record<
    string,
    { arguments: Record<string, unknown> }
  >;
}

export type ModelGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelGetData }
  | { kind: "error"; error: SwampError };

type ModelGetLookupResult = {
  definition: Definition;
  type: ModelType;
  autoCreated?: boolean;
} | null;

export interface ModelGetDeps {
  lookupDefinition: (idOrName: string) => Promise<ModelGetLookupResult>;
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
  ) => Promise<ModelGetLookupResult>;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
}

export async function createModelGetDeps(
  definitionRepo: YamlDefinitionRepository,
): Promise<ModelGetDeps> {
  await modelRegistry.ensureLoaded();
  const withAutoCreated = async (
    result: DefinitionLookupResult | null,
  ): Promise<ModelGetLookupResult> => {
    if (!result) return null;
    const autoCreated = await definitionRepo.isAutoDefinition(
      result.definition,
      result.type,
    );
    return { ...result, autoCreated };
  };
  return {
    lookupDefinition: async (idOrName) =>
      withAutoCreated(await findDefinitionByIdOrName(definitionRepo, idOrName)),
    lookupDefinitionById: async (id, expectedName) =>
      withAutoCreated(
        await findDefinitionByIdGlobal(definitionRepo, id, expectedName),
      ),
    getModelDef: async (type) => {
      await modelRegistry.ensureTypeLoaded(type);
      return modelRegistry.get(type);
    },
  };
}

export async function* modelGet(
  _ctx: LibSwampContext,
  deps: ModelGetDeps,
  modelIdOrName: string,
  options: LookupOptions = {},
): AsyncIterable<ModelGetEvent> {
  yield* withGeneratorSpan(
    "swamp.model.get",
    { "model.id_or_name": modelIdOrName },
    (async function* () {
      yield { kind: "resolving" };

      const lookup = selectLookup(
        "model get",
        options.byId,
        deps.lookupDefinition,
        deps.lookupDefinitionById,
        options.expectedName,
      );
      const result = await lookup(modelIdOrName);
      if (!result) {
        yield { kind: "error", error: behaviorNotFound(modelIdOrName) };
        return;
      }

      const { definition, type: modelType, autoCreated } = result;
      const modelDef = await deps.getModelDef(modelType);

      // redact sensitive global arguments before they enter the read model so
      // every output mode and consumer inherits it; when the model type is
      // unavailable the schema is unknown and values pass through unredacted
      const globalArguments = modelDef?.globalArguments
        ? redactSensitiveValues(
          modelDef.globalArguments,
          definition.globalArguments,
        )
        : definition.globalArguments;

      const configuredMethods: Record<
        string,
        { arguments: Record<string, unknown> }
      > = {};
      for (const [name, methodData] of Object.entries(definition.methodData)) {
        if (methodData.arguments === undefined) continue;
        const schema = modelDef?.methods[name]?.arguments;
        configuredMethods[name] = {
          arguments: schema
            ? redactSensitiveValues(schema, methodData.arguments)
            : methodData.arguments,
        };
      }

      const data: ModelGetData = {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        type: modelType.normalized,
        version: definition.version,
        tags: definition.tags,
        globalArguments,
        autoCreated: autoCreated || undefined,
        typeVersion: definition.typeVersion,
        currentTypeVersion: modelDef?.version,
        staleness: modelDef
          ? resolveStaleness(
            definition.typeVersion,
            modelDef.version,
            (modelDef.upgrades ?? []).map((u) => u.toVersion),
          ).state
          : undefined,
        globalArgumentsSchema: modelDef?.globalArguments
          ? zodToJsonSchema(modelDef.globalArguments)
          : undefined,
        methods: modelDef
          ? Object.entries(modelDef.methods).map(
            ([name, method]) => toMethodDescribeData(name, method),
          )
          : undefined,
        configuredMethods: Object.keys(configuredMethods).length > 0
          ? configuredMethods
          : undefined,
      };

      yield { kind: "completed", data };
    })(),
  );
}
