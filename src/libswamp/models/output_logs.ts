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

import type { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";
import {
  type OutputIdReference,
  type OutputIdReferenceDeps,
  resolveOutputIdReference,
} from "./output_reference.ts";

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
  /**
   * The output id, already resolved with resolveOutputIdReference. The read
   * acts on exactly this and does not look the id up again.
   */
  reference?: OutputIdReference<ModelOutput>;
}

/** Dependencies for the model output logs operation. */
export interface ModelOutputLogsDeps
  extends OutputIdReferenceDeps<ModelOutput> {
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
  injectedDataRepo?: FileSystemUnifiedDataRepository,
): ModelOutputLogsDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
  );
  // Reuse an injected shared data repo (e.g. serve's process-scoped
  // RepositoryContext) so we don't open a new file-based catalog store — and
  // leak its 3 FDs — on every request.
  const dataRepo = injectedDataRepo ?? new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
    undefined,
    undefined,
    namespaceFromResolver(datastoreResolver),
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

      const reference = input.reference ??
        await resolveOutputIdReference(deps, input.outputIdArg);

      if (reference.kind === "invalid") {
        yield {
          kind: "error",
          error: validationFailed(
            `Invalid output ID format: ${input.outputIdArg}. ` +
              `Expected a UUID or partial ID (3+ hex characters).`,
          ),
        };
        return;
      }

      if (reference.kind === "not_found") {
        yield {
          kind: "error",
          error: notFound("Output", input.outputIdArg),
        };
        return;
      }

      if (reference.kind === "ambiguous") {
        yield {
          kind: "error",
          error: validationFailed(
            `Ambiguous ID prefix "${input.outputIdArg}" matches:\n` +
              reference.ids.map((id) => `  ${id}`).join("\n"),
          ),
        };
        return;
      }

      const { output, type } = reference.match;

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
            for (const line of lines) allEntries.push(line);
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
