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

import type { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Data payload for the completed event. */
export interface ModelOutputLogsData {
  outputId: string;
  methodName: string;
  logArtifacts: string[];
  lines: string[];
  totalLines: number;
  showingLines: number;
}

export type ModelOutputLogsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelOutputLogsData }
  | { kind: "error"; error: SwampError };

export interface ModelOutputLogsInput {
  outputIdArg: string;
  tail?: number;
}

/** Partial ID match result. */
interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: { output: ModelOutput; type: ModelType };
  matches?: Array<{ id: string }>;
}

/** Dependencies for the model output logs operation. */
export interface ModelOutputLogsDeps {
  isPartialId: (value: string) => boolean;
  matchOutputByPartialId: (
    idPrefix: string,
  ) => Promise<PartialMatchResult>;
  findDataByName: (
    type: ModelType,
    definitionId: string,
    name: string,
  ) => Promise<unknown | null>;
  getContent: (
    type: ModelType,
    definitionId: string,
    name: string,
  ) => Promise<Uint8Array | null>;
}

/** Wires real infrastructure into ModelOutputLogsDeps. */
export function createModelOutputLogsDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): ModelOutputLogsDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
  );
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
    findDataByName: (type, definitionId, name) =>
      dataRepo.findByName(type, definitionId, name),
    getContent: (type, definitionId, name) =>
      dataRepo.getContent(type, definitionId, name),
  };
}

/** Yields log artifact content for a model output. */
export async function* modelOutputLogs(
  _ctx: LibSwampContext,
  deps: ModelOutputLogsDeps,
  input: ModelOutputLogsInput,
): AsyncIterable<ModelOutputLogsEvent> {
  yield* withGeneratorSpan(
    "swamp.model.output.logs",
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

      // Get log IDs from artifacts (find all artifacts with type "log")
      const logArtifacts = output.artifacts.dataArtifacts.filter(
        (a) => a.tags.type === "log",
      );
      if (logArtifacts.length === 0) {
        yield {
          kind: "error",
          error: notFound(
            "Log artifacts",
            `Output ${output.id} has no log artifacts. ` +
              `Status: ${output.status}, Method: ${output.methodName}`,
          ),
        };
        return;
      }

      // Fetch and collect log lines
      const allEntries: string[] = [];

      for (const artifact of logArtifacts) {
        const dataResult = await deps.findDataByName(
          type,
          output.definitionId,
          artifact.name,
        );
        if (dataResult) {
          const content = await deps.getContent(
            type,
            output.definitionId,
            artifact.name,
          );
          if (content) {
            const text = new TextDecoder().decode(content);
            const lines = text.split("\n").filter((line) => line.length > 0);
            allEntries.push(...lines);
          }
        }
      }

      // Apply --tail if specified
      const entriesToShow = input.tail
        ? allEntries.slice(-input.tail)
        : allEntries;

      yield {
        kind: "completed",
        data: {
          outputId: output.id,
          methodName: output.methodName,
          logArtifacts: logArtifacts.map((a) => a.name),
          lines: entriesToShow,
          totalLines: allEntries.length,
          showingLines: entriesToShow.length,
        },
      };
    })(),
  );
}
