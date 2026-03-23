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

import type { ModelDefinition } from "../../domain/models/model.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "./schema_helpers.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the type describe output.
 */
export interface TypeDescribeData {
  type: {
    raw: string;
    normalized: string;
  };
  version: string;
  globalArguments?: object;
  methods: MethodDescribeData[];
}

export type TypeDescribeEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TypeDescribeData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the type describe operation. */
export interface TypeDescribeDeps {
  resolveModelType: (
    type: ModelType,
  ) => Promise<ModelDefinition | undefined>;
  getAvailableTypes: () => string[];
}

/** Wires real infrastructure into TypeDescribeDeps. */
export function createTypeDescribeDeps(): TypeDescribeDeps {
  return {
    resolveModelType: (type) => resolveModelType(type, null),
    getAvailableTypes: () => modelRegistry.types().map((t) => t.normalized),
  };
}

/** Describes a model type with schema details. */
export async function* typeDescribe(
  _ctx: LibSwampContext,
  deps: TypeDescribeDeps,
  modelType: ModelType,
): AsyncIterable<TypeDescribeEvent> {
  yield* withGeneratorSpan(
    "swamp.type.describe",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const definition = await deps.resolveModelType(modelType);
      if (!definition) {
        const availableTypes = deps.getAvailableTypes().join(", ");
        yield {
          kind: "error",
          error: notFound(
            "Model type",
            `${modelType.raw}. Available types: ${availableTypes || "none"}`,
          ),
        };
        return;
      }

      const globalArguments = definition.globalArguments
        ? zodToJsonSchema(definition.globalArguments)
        : undefined;

      const methods: MethodDescribeData[] = Object.entries(definition.methods)
        .map(
          ([name, method]) =>
            toMethodDescribeData(
              name,
              method,
              definition.resources,
              definition.files,
            ),
        );

      yield {
        kind: "completed",
        data: {
          type: {
            raw: modelType.raw,
            normalized: modelType.normalized,
          },
          version: definition.version,
          globalArguments,
          methods,
        },
      };
    })(),
  );
}
