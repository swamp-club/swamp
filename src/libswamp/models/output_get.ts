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
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";
import {
  type OutputReference,
  type OutputReferenceDeps,
  resolveOutputReference,
} from "./output_reference.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for provenance information.
 */
export interface ProvenanceData {
  definitionHash: string;
  modelVersion: string;
  triggeredBy: string;
  workflowId?: string;
  workflowRunId?: string;
  stepName?: string;
  bundleFingerprint?: string;
}

/**
 * Data structure for a data artifact reference.
 */
export interface DataArtifactRefData {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

/**
 * Data structure for artifacts information.
 */
export interface ArtifactsData {
  dataArtifacts: DataArtifactRefData[];
}

/**
 * Data structure for error information.
 */
export interface ErrorData {
  message: string;
  stack?: string;
}

/**
 * Data structure for the model output get output.
 */
export interface ModelOutputGetData {
  id: string;
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  provenance: ProvenanceData;
  artifacts?: ArtifactsData;
  error?: ErrorData;
}

/** Minimal output shape for the generator. */
export interface OutputInfo {
  id: string;
  definitionId: string;
  methodName: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  retryCount: number;
  provenance: ProvenanceData;
  artifacts?: ArtifactsData;
  error?: ErrorData;
}

/** Global output with type info. */
export interface GlobalOutputInfo {
  output: OutputInfo;
  type: ModelType;
}

export type ModelOutputGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputGetData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the model output get operation. */
export interface ModelOutputGetDeps extends OutputReferenceDeps<OutputInfo> {
  findOutputsByDefinition: (
    type: ModelType,
    definitionId: string,
  ) => Promise<OutputInfo[]>;
  findDefinitionById: (
    type: ModelType,
    definitionId: string,
  ) => Promise<Definition | null>;
  modelTypes: () => ModelType[];
}

/** Options for {@link modelOutputGet}. */
export interface ModelOutputGetOptions {
  /**
   * The argument, already resolved with resolveOutputReference. The read acts
   * on exactly this and does not look the argument up again.
   */
  reference?: OutputReference<OutputInfo>;
}

/** Wires real infrastructure into ModelOutputGetDeps. */
export async function createModelOutputGetDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): Promise<ModelOutputGetDeps> {
  await modelRegistry.ensureLoaded();
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(repoDir);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
  );
  return {
    isPartialId,
    matchOutputByPartialId: async (idPrefix) => {
      const outputs = await outputRepo.findAllGlobal();
      const result = matchByPartialId(
        outputs.map((o) => ({ id: o.output.id, item: o })),
        idPrefix,
      );
      if (result.status === "found") {
        return { status: "found", match: result.match };
      }
      if (result.status === "ambiguous") {
        return {
          status: "ambiguous",
          matches: result.matches.map((m) => ({
            id: m.id,
            match: m.match,
          })),
        };
      }
      return { status: "not_found" };
    },
    findDefinitionByIdOrName: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findLatestOutput: (type, defId) =>
      outputRepo.findLatestByDefinition(type, createDefinitionId(defId)),
    findOutputsByDefinition: (type, defId) =>
      outputRepo.findByDefinition(type, createDefinitionId(defId)),
    findDefinitionById: (type, defId) =>
      definitionRepo.findById(type, createDefinitionId(defId)),
    modelTypes: () => [...modelRegistry.types()],
  };
}

/** Retrieves model output details by output ID or model name. */
export async function* modelOutputGet(
  _ctx: LibSwampContext,
  deps: ModelOutputGetDeps,
  outputIdOrModelName: string,
  options: ModelOutputGetOptions = {},
): AsyncIterable<ModelOutputGetEvent> {
  yield* withGeneratorSpan(
    "swamp.model.output.get",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const reference = options.reference ??
        await resolveOutputReference(deps, outputIdOrModelName);
      switch (reference.kind) {
        case "output": {
          const { output, type } = reference.match;
          const modelName = await resolveModelName(deps, output.definitionId);
          yield {
            kind: "completed",
            data: toOutputData(output, type, modelName),
          };
          return;
        }
        case "ambiguous":
          yield {
            kind: "error",
            error: {
              code: "ambiguous_id",
              message:
                `Ambiguous ID prefix "${outputIdOrModelName}" matches:\n` +
                reference.ids.map((id) => `  ${id}`).join("\n"),
            },
          };
          return;
        case "not_found":
          yield {
            kind: "error",
            error: notFound("Output or model", outputIdOrModelName),
          };
          return;
        case "model":
          if (!reference.latest) {
            yield {
              kind: "error",
              error: notFound(
                "Output",
                `no outputs for model: ${reference.definition.name}`,
              ),
            };
            return;
          }
          yield {
            kind: "completed",
            data: toOutputData(
              reference.latest,
              reference.type,
              reference.definition.name,
            ),
          };
      }
    })(),
  );
}

async function resolveModelName(
  deps: ModelOutputGetDeps,
  definitionId: string,
): Promise<string | undefined> {
  for (const modelType of deps.modelTypes()) {
    const outputs = await deps.findOutputsByDefinition(
      modelType,
      definitionId,
    );
    if (outputs.length > 0) {
      const definition = await deps.findDefinitionById(
        modelType,
        definitionId,
      );
      if (definition) {
        return definition.name;
      }
    }
  }
  return undefined;
}

function toOutputData(
  output: OutputInfo,
  type: ModelType,
  modelName?: string,
): ModelOutputGetData {
  return {
    id: output.id,
    definitionId: output.definitionId,
    modelName,
    type: type.normalized,
    methodName: output.methodName,
    status: output.status,
    startedAt: output.startedAt.toISOString(),
    completedAt: output.completedAt?.toISOString(),
    durationMs: output.durationMs,
    retryCount: output.retryCount,
    provenance: output.provenance,
    artifacts: output.artifacts,
    error: output.error,
  };
}
