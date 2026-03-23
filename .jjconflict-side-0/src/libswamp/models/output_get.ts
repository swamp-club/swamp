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
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
  type PartialIdResult,
} from "../../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";

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
export interface ModelOutputGetDeps {
  findAllOutputsGlobal: () => Promise<GlobalOutputInfo[]>;
  findDefinitionByIdOrName: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findLatestOutputByDefinition: (
    type: ModelType,
    definitionId: string,
  ) => Promise<OutputInfo | null>;
  findOutputsByDefinition: (
    type: ModelType,
    definitionId: string,
  ) => Promise<OutputInfo[]>;
  findDefinitionById: (
    type: ModelType,
    definitionId: string,
  ) => Promise<Definition | null>;
  matchByPartialId: (
    items: Array<{ id: string; item: GlobalOutputInfo }>,
    partialId: string,
  ) => PartialIdResult<GlobalOutputInfo>;
  isPartialId: (value: string) => boolean;
  modelTypes: () => ModelType[];
}

/** Wires real infrastructure into ModelOutputGetDeps. */
export function createModelOutputGetDeps(repoDir: string): ModelOutputGetDeps {
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const outputRepo = new YamlOutputRepository(repoDir);
  return {
    findAllOutputsGlobal: () => outputRepo.findAllGlobal(),
    findDefinitionByIdOrName: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findLatestOutputByDefinition: (type, defId) =>
      outputRepo.findLatestByDefinition(type, createDefinitionId(defId)),
    findOutputsByDefinition: (type, defId) =>
      outputRepo.findByDefinition(type, createDefinitionId(defId)),
    findDefinitionById: (type, defId) =>
      definitionRepo.findById(type, createDefinitionId(defId)),
    matchByPartialId,
    isPartialId,
    modelTypes: () => [...modelRegistry.types()],
  };
}

/** Retrieves model output details by output ID or model name. */
export async function* modelOutputGet(
  _ctx: LibSwampContext,
  deps: ModelOutputGetDeps,
  outputIdOrModelName: string,
): AsyncIterable<ModelOutputGetEvent> {
  yield* withGeneratorSpan(
    "swamp.model.output.get",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (deps.isPartialId(outputIdOrModelName)) {
        yield* lookupByPartialId(deps, outputIdOrModelName);
      } else {
        yield* lookupByModelName(deps, outputIdOrModelName);
      }
    })(),
  );
}

async function* lookupByPartialId(
  deps: ModelOutputGetDeps,
  partialId: string,
): AsyncIterable<ModelOutputGetEvent> {
  const allOutputs = await deps.findAllOutputsGlobal();
  const matchResult = deps.matchByPartialId(
    allOutputs.map((o) => ({ id: o.output.id, item: o })),
    partialId,
  );

  if (matchResult.status === "found") {
    const { output, type } = matchResult.match;

    const modelName = await resolveModelName(deps, output.definitionId);

    yield {
      kind: "completed",
      data: toOutputData(output, type, modelName),
    };
  } else if (matchResult.status === "ambiguous") {
    yield {
      kind: "error",
      error: {
        code: "ambiguous_id",
        message: `Ambiguous ID prefix "${partialId}" matches:\n` +
          matchResult.matches.map((m) => `  ${m.id}`).join("\n"),
      },
    };
  } else {
    // not_found - try as definition ID or name
    yield* lookupByModelName(deps, partialId);
  }
}

async function* lookupByModelName(
  deps: ModelOutputGetDeps,
  idOrName: string,
): AsyncIterable<ModelOutputGetEvent> {
  const definitionResult = await deps.findDefinitionByIdOrName(idOrName);
  if (!definitionResult) {
    yield {
      kind: "error",
      error: notFound("Output or model", idOrName),
    };
    return;
  }

  const latestOutput = await deps.findLatestOutputByDefinition(
    definitionResult.type,
    definitionResult.definition.id,
  );
  if (!latestOutput) {
    yield {
      kind: "error",
      error: notFound(
        "Output",
        `no outputs for model: ${definitionResult.definition.name}`,
      ),
    };
    return;
  }

  yield {
    kind: "completed",
    data: toOutputData(
      latestOutput,
      definitionResult.type,
      definitionResult.definition.name,
    ),
  };
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
