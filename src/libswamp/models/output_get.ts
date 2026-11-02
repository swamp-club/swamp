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
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { wordedSwampError } from "../errors.ts";
import { wordedText } from "../../domain/behavior_wording.ts";
import {
  type OutputReference,
  type OutputReferenceDeps,
  resolveOutputReference,
} from "./output_reference.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { withReapedHint } from "../retention/reaped.ts";
import type { RetentionWatermarkRepository } from "../../domain/retention/retention_watermark.ts";
export interface ProvenanceData {
  definitionHash: string;
  modelVersion: string;
  triggeredBy: string;
  workflowId?: string;
  workflowRunId?: string;
  stepName?: string;
  bundleFingerprint?: string;
}

export interface DataArtifactRefData {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
}

export interface ArtifactsData {
  dataArtifacts: DataArtifactRefData[];
}

export interface ErrorData {
  message: string;
  stack?: string;
}

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

export interface GlobalOutputInfo {
  output: OutputInfo;
  type: ModelType;
}

export type ModelOutputGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputGetData }
  | { kind: "error"; error: SwampError };

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
  /**
   * where retention records how far it has reaped; with it, a not-found output
   * says outputs before the cutoff have been reaped
   */
  retentionWatermarks?: RetentionWatermarkRepository;
}

export interface ModelOutputGetOptions {
  /**
   * The argument, already resolved with resolveOutputReference. The read acts
   * on exactly this and does not look the argument up again.
   */
  reference?: OutputReference<OutputInfo>;
}

export async function createModelOutputGetDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDefinitionRepo?: YamlDefinitionRepository,
  /**
   * the repository context's lookup, so an output record the v3 read model
   * could not materialise fails a lookup loudly and is named by a listing that
   * leaves it out
   */
  unreadableContent?: UnreadableContentLookup,
): Promise<ModelOutputGetDeps> {
  await modelRegistry.ensureLoaded();
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(repoDir);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    undefined,
    unreadableContent,
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
            // The details keep notFound's shape; only the text is worded.
            error: await withReapedHint(
              wordedSwampError(
                "not_found",
                wordedText((w) =>
                  `Output or ${w.noun} not found: ${outputIdOrModelName}`
                ),
                {
                  entityType: "Output or model",
                  idOrName: outputIdOrModelName,
                },
              ),
              "outputs",
              deps.retentionWatermarks,
            ),
          };
          return;
        case "model":
          if (!reference.latest) {
            yield {
              kind: "error",
              error: await withReapedHint(
                wordedSwampError(
                  "not_found",
                  wordedText((w) =>
                    `Output not found: no outputs for ${w.noun}: ${reference.definition.name}`
                  ),
                  {
                    entityType: "Output",
                    idOrName:
                      `no outputs for model: ${reference.definition.name}`,
                  },
                ),
                "outputs",
                deps.retentionWatermarks,
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
