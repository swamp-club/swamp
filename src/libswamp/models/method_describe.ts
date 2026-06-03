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
import type { ModelDefinition } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
} from "../types/schema_helpers.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the model method describe output.
 */
export interface ModelMethodDescribeData {
  modelName: string;
  modelType: string;
  version: string;
  method: MethodDescribeData;
}

export type ModelMethodDescribeEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelMethodDescribeData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the model method describe operation. */
export interface ModelMethodDescribeDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  resolveModelType: (
    type: ModelType,
  ) => Promise<ModelDefinition | undefined>;
}

/** Wires real infrastructure into ModelMethodDescribeDeps. */
export function createModelMethodDescribeDeps(
  repoDir: string,
): ModelMethodDescribeDeps {
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    resolveModelType: (type) => resolveModelType(type, null),
  };
}

/** Describes a method on a model with argument details. */
export async function* modelMethodDescribe(
  _ctx: LibSwampContext,
  deps: ModelMethodDescribeDeps,
  modelIdOrName: string,
  methodName: string,
): AsyncIterable<ModelMethodDescribeEvent> {
  yield* withGeneratorSpan(
    "swamp.model.method.describe",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const result = await deps.lookupDefinition(modelIdOrName);
      if (!result) {
        yield { kind: "error", error: notFound("Model", modelIdOrName) };
        return;
      }

      const { definition, type: modelType } = result;
      const modelDef = await deps.resolveModelType(modelType);
      if (!modelDef) {
        yield {
          kind: "error",
          error: notFound("Model type", modelType.normalized),
        };
        return;
      }

      const method = modelDef.methods[methodName];
      if (!method) {
        const availableMethods = Object.keys(modelDef.methods).join(", ");
        yield {
          kind: "error",
          error: {
            code: "unknown_method",
            message:
              `Unknown method '${methodName}' for type '${modelType.normalized}'. Available methods: ${
                availableMethods || "none"
              }`,
          },
        };
        return;
      }

      const methodData = toMethodDescribeData(
        methodName,
        method,
        modelDef.resources,
        modelDef.files,
      );

      yield {
        kind: "completed",
        data: {
          modelName: definition.name,
          modelType: modelType.normalized,
          version: modelDef.version,
          method: methodData,
        },
      };
    })(),
  );
}
