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

import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type {
  DataArtifactRef,
  ModelOutput,
} from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Data payload for the completed event. */
export interface ModelOutputDataData {
  outputId: string;
  methodName: string;
  dataId: string;
  dataName: string;
  version: number;
  contentType: string;
  field: string | null;
  data: unknown;
}

export type ModelOutputDataEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputDataData }
  | { kind: "error"; error: SwampError };

export interface ModelOutputDataInput {
  outputIdArg: string;
  name?: string;
  field?: string;
  version?: number;
}

/** Data metadata. */
interface DataMeta {
  id: string;
  name: string;
  version: number;
  contentType: string;
}

/** Partial ID match result. */
interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: { output: ModelOutput; type: ModelType };
  matches?: Array<{ id: string }>;
}

/** Dependencies for the model output data operation. */
export interface ModelOutputDataDeps {
  isPartialId: (value: string) => boolean;
  matchOutputByPartialId: (
    idPrefix: string,
  ) => Promise<PartialMatchResult>;
  findDefinition: (
    type: ModelType,
    definitionId: DefinitionId,
  ) => Promise<{ id: string; name: string } | null>;
  findDataByName: (
    type: ModelType,
    definitionId: string,
    name: string,
    version?: number,
  ) => Promise<DataMeta | null>;
  getContent: (
    type: ModelType,
    definitionId: string,
    name: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
}

/** Wires real infrastructure into ModelOutputDataDeps. */
export function createModelOutputDataDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): ModelOutputDataDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
  );
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
  );
  return {
    isPartialId,
    matchOutputByPartialId: async (idPrefix: string) => {
      const allOutputs = await outputRepo.findAllGlobal();
      const result = matchByPartialId(
        allOutputs.map((o) => ({ id: o.output.id, item: o })),
        idPrefix,
      );
      if (result.status === "found") {
        return {
          status: "found" as const,
          match: { output: result.match.output, type: result.match.type },
        };
      }
      if (result.status === "ambiguous") {
        return {
          status: "ambiguous" as const,
          matches: result.matches.map((m) => ({ id: m.id })),
        };
      }
      return { status: "not_found" as const };
    },
    findDefinition: async (type, definitionId) => {
      const def = await definitionRepo.findById(type, definitionId);
      return def ? { id: def.id, name: def.name } : null;
    },
    findDataByName: (type, definitionId, name, version) =>
      dataRepo.findByName(type, definitionId, name, version),
    getContent: (type, definitionId, name, version) =>
      dataRepo.getContent(type, definitionId, name, version),
  };
}

/** Yields data artifact content for a model output. */
export async function* modelOutputData(
  _ctx: LibSwampContext,
  deps: ModelOutputDataDeps,
  input: ModelOutputDataInput,
): AsyncIterable<ModelOutputDataEvent> {
  yield* withGeneratorSpan(
    "swamp.model.output.data",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (!deps.isPartialId(input.outputIdArg)) {
        yield {
          kind: "error",
          error: validationFailed(
            `Invalid output ID format: ${input.outputIdArg}. ` +
              `Expected a UUID or partial ID (3+ hex characters).`,
          ),
        };
        return;
      }

      const result = await deps.matchOutputByPartialId(input.outputIdArg);

      if (result.status === "not_found") {
        yield {
          kind: "error",
          error: notFound("Output", input.outputIdArg),
        };
        return;
      }

      if (result.status === "ambiguous" && result.matches) {
        yield {
          kind: "error",
          error: validationFailed(
            `Ambiguous ID prefix "${input.outputIdArg}" matches:\n` +
              result.matches.map((m) => `  ${m.id}`).join("\n"),
          ),
        };
        return;
      }

      const { output, type } = result.match!;

      // Find the data artifact
      let dataArtifact: DataArtifactRef | undefined;
      if (input.name) {
        dataArtifact = output.artifacts.dataArtifacts.find(
          (a) => a.name === input.name,
        );
        if (!dataArtifact) {
          const availableNames = output.artifacts.dataArtifacts
            .map((a) => a.name)
            .join(", ");
          yield {
            kind: "error",
            error: notFound(
              "Data artifact",
              `"${input.name}". Available: ${availableNames || "(none)"}`,
            ),
          };
          return;
        }
      } else {
        dataArtifact = output.artifacts.dataArtifacts.find(
          (a) => a.tags.type === "data",
        ) ?? output.artifacts.dataArtifacts[0];
      }

      if (!dataArtifact) {
        yield {
          kind: "error",
          error: notFound(
            "Data artifacts",
            `Output ${output.id} has no data artifacts. ` +
              `Status: ${output.status}, Method: ${output.methodName}`,
          ),
        };
        return;
      }

      // Get the definition
      const definition = await deps.findDefinition(type, output.definitionId);
      if (!definition) {
        yield {
          kind: "error",
          error: notFound(
            "Definition",
            `${output.definitionId} for output ${output.id}`,
          ),
        };
        return;
      }

      // Get the version
      const version = input.version ?? dataArtifact.version;

      // Find the data
      const data = await deps.findDataByName(
        type,
        definition.id,
        dataArtifact.name,
        version,
      );

      if (!data) {
        yield {
          kind: "error",
          error: notFound(
            "Data",
            `"${dataArtifact.name}" (v${version}) for model "${definition.name}"`,
          ),
        };
        return;
      }

      // Get the raw content
      const content = await deps.getContent(
        type,
        definition.id,
        dataArtifact.name,
        version,
      );

      if (!content) {
        yield {
          kind: "error",
          error: notFound(
            "Data content",
            `"${dataArtifact.name}" (v${version})`,
          ),
        };
        return;
      }

      // Try to parse as JSON if content type is JSON
      let displayData: unknown;
      const isJson = data.contentType === "application/json";

      if (isJson) {
        try {
          const text = new TextDecoder().decode(content);
          displayData = JSON.parse(text);
        } catch {
          displayData = new TextDecoder().decode(content);
        }
      } else {
        displayData = new TextDecoder().decode(content);
      }

      // If a specific field is requested, extract it
      if (input.field) {
        if (typeof displayData !== "object" || displayData === null) {
          yield {
            kind: "error",
            error: validationFailed(
              `Cannot extract field "${input.field}": data is not a JSON object`,
            ),
          };
          return;
        }
        const fieldValue =
          (displayData as Record<string, unknown>)[input.field];
        if (fieldValue === undefined) {
          const availableFields = Object.keys(displayData as object).join(", ");
          yield {
            kind: "error",
            error: notFound(
              "Field",
              `"${input.field}" in data artifact. Available fields: ${
                availableFields || "(none)"
              }`,
            ),
          };
          return;
        }
        displayData = fieldValue;
      }

      yield {
        kind: "completed",
        data: {
          outputId: output.id,
          methodName: output.methodName,
          dataId: data.id,
          dataName: data.name,
          version: data.version,
          contentType: data.contentType,
          field: input.field ?? null,
          data: displayData,
        },
      };
    })(),
  );
}
