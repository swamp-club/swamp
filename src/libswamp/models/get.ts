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

import type { Definition } from "../../domain/definitions/definition.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../types/schema_helpers.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the model get output.
 */
export interface ModelGetData {
  id: string;
  name: string;
  type: string;
  version: number;
  tags: Record<string, string>;
  globalArguments: Record<string, unknown>;
  typeVersion?: string;
  globalArgumentsSchema?: object;
  methods?: MethodDescribeData[];
}

export type ModelGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelGetData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the model get operation. */
export interface ModelGetDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  getModelDef: (
    type: ModelType,
  ) => ModelDefinition | undefined | Promise<ModelDefinition | undefined>;
}

/** Wires real infrastructure into ModelGetDeps. */
export async function createModelGetDeps(
  repoDir: string,
): Promise<ModelGetDeps> {
  await modelRegistry.ensureLoaded();
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    getModelDef: async (type) => {
      await modelRegistry.ensureTypeLoaded(type);
      return modelRegistry.get(type);
    },
  };
}

/** Retrieves model definition details. */
export async function* modelGet(
  _ctx: LibSwampContext,
  deps: ModelGetDeps,
  modelIdOrName: string,
): AsyncIterable<ModelGetEvent> {
  yield* withGeneratorSpan(
    "swamp.model.get",
    { "model.id_or_name": modelIdOrName },
    (async function* () {
      yield { kind: "resolving" };

      const result = await deps.lookupDefinition(modelIdOrName);
      if (!result) {
        yield { kind: "error", error: notFound("Model", modelIdOrName) };
        return;
      }

      const { definition, type: modelType } = result;
      const modelDef = await deps.getModelDef(modelType);

      const data: ModelGetData = {
        id: definition.id,
        name: definition.name,
        type: modelType.normalized,
        version: definition.version,
        tags: definition.tags,
        globalArguments: definition.globalArguments,
        typeVersion: modelDef?.version,
        globalArgumentsSchema: modelDef?.globalArguments
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
