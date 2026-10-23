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
  type ModelDefinition,
  modelRegistry,
} from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { behaviorTypeNotFound } from "../errors.ts";
import {
  buildDataOutputSpecs,
  type DataOutputSpecDescribeData,
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
  dataOutputSpecs?: DataOutputSpecDescribeData[];
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
  /**
   * The types an installed extension of this name provides, so a type not
   * found that is an extension's name can point at them. Absent means no
   * suggestion.
   */
  typesProvidedByExtension?: (extensionName: string) => string[];
}

/** Wires real infrastructure into TypeDescribeDeps. */
export function createTypeDescribeDeps(): TypeDescribeDeps {
  return {
    resolveModelType: (type) => resolveModelType(type, null),
    typesProvidedByExtension: (extensionName) =>
      modelRegistry.typesProvidedByExtension(extensionName).map((t) =>
        t.normalized
      ),
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
        const installName = deriveInstallName(modelType.normalized);
        const provided = deps.typesProvidedByExtension?.(installName) ?? [];
        yield {
          kind: "error",
          error: behaviorTypeNotFound(
            `${modelType.raw}\n\n` +
              (provided.length > 0
                ? installedExtensionHint(installName, provided)
                : registryHint(modelType.normalized, installName)),
          ),
        };
        return;
      }

      const globalArguments = definition.globalArguments
        ? zodToJsonSchema(definition.globalArguments)
        : undefined;

      const specs = buildDataOutputSpecs(
        definition.resources,
        definition.files,
      );

      const methods: MethodDescribeData[] = Object.entries(definition.methods)
        .map(
          ([name, method]) => toMethodDescribeData(name, method),
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
          dataOutputSpecs: specs.length > 0 ? specs : undefined,
          methods,
        },
      };
    })(),
  );
}

/**
 * Points a name that is an installed extension's, not a type's, at the
 * types that extension provides (swamp-club#3819).
 */
function installedExtensionHint(
  extensionName: string,
  types: string[],
): string {
  if (types.length === 1) {
    return `Did you mean ${
      types[0]
    }? (provided by installed extension ${extensionName})`;
  }
  return `Did you mean one of these types provided by installed extension ${extensionName}?\n` +
    types.map((type) => `  ${type}`).join("\n");
}

/** Suggests finding the type in the extension registry. */
function registryHint(normalized: string, installName: string): string {
  return `This type may be available as an extension:\n` +
    `  Search:  swamp extension search ${deriveSearchTerm(normalized)}\n` +
    `  Install: swamp extension pull ${installName}`;
}

/**
 * Derives a search term from a normalized type by stripping the collective prefix.
 * e.g., "@swamp/gcp/oauth2" → "gcp/oauth2", "swamp/echo" → "echo"
 */
function deriveSearchTerm(normalized: string): string {
  let stripped = normalized;
  if (stripped.startsWith("@")) {
    stripped = stripped.slice(1);
  }
  const firstSlash = stripped.indexOf("/");
  if (firstSlash !== -1) {
    return stripped.slice(firstSlash + 1);
  }
  return stripped;
}

/**
 * Derives an install name from a normalized type by ensuring the @ prefix.
 * e.g., "swamp/echo" → "@swamp/echo", "@swamp/gcp/oauth2" → "@swamp/gcp/oauth2"
 */
function deriveInstallName(normalized: string): string {
  return normalized.startsWith("@") ? normalized : `@${normalized}`;
}
