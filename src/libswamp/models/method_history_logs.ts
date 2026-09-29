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

import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type { ModelOutput } from "../../domain/models/model_output.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { readLogFile } from "../../presentation/output/log_file_reader.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";
import {
  type OutputReference,
  type OutputReferenceDeps,
  resolveOutputReference,
} from "./output_reference.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Log file data. */
export interface LogData {
  lines: string[];
  path: string;
}

/** No log file data (pre-logFile runs). */
export interface NoLogFileData {
  outputId: string;
  modelName: string;
  methodName: string;
}

/** Empty log file data. */
export interface EmptyLogData {
  outputId: string;
  methodName: string;
  path: string;
}

export type MethodHistoryLogsCompletedData =
  | { type: "log"; log: LogData }
  | { type: "no_log_file"; info: NoLogFileData }
  | { type: "empty_log"; info: EmptyLogData };

export type ModelMethodHistoryLogsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: MethodHistoryLogsCompletedData }
  | { kind: "error"; error: SwampError };

export interface ModelMethodHistoryLogsInput {
  outputIdOrModelName: string;
  tail?: number;
  repoDir: string;
  /**
   * The argument, already resolved with resolveOutputReference. The read acts
   * on exactly this and does not look the argument up again.
   */
  reference?: OutputReference<ModelOutput>;
}

/** Dependencies for the model method history logs operation. */
export interface ModelMethodHistoryLogsDeps
  extends OutputReferenceDeps<ModelOutput> {
  getModelName: (
    definitionId: string,
  ) => Promise<string>;
  readLogFile: (
    path: string,
    options?: { tail?: number },
  ) => Promise<LogData>;
  toRelativePath: (repoDir: string, path: string) => string;
}

/** Wires real infrastructure into ModelMethodHistoryLogsDeps. */
export async function createModelMethodHistoryLogsDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): Promise<ModelMethodHistoryLogsDeps> {
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
    matchOutputByPartialId: async (idPrefix: string) => {
      const allOutputs = await outputRepo.findAllGlobal();
      const result = matchByPartialId(
        allOutputs.map((o) => ({ id: o.output.id, item: o })),
        idPrefix,
      );
      if (result.status === "found") {
        return { status: "found" as const, match: result.match };
      }
      if (result.status === "ambiguous") {
        return {
          status: "ambiguous" as const,
          matches: result.matches.map((m) => ({
            id: m.id,
            match: m.match,
          })),
        };
      }
      return { status: "not_found" as const };
    },
    findDefinitionByIdOrName: (idOrName: string) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findLatestOutput: (type, definitionId) =>
      outputRepo.findLatestByDefinition(type, definitionId as DefinitionId),
    getModelName: async (definitionId: string) => {
      for (const modelType of modelRegistry.types()) {
        const definition = await definitionRepo.findById(
          modelType,
          definitionId as DefinitionId,
        );
        if (definition) {
          return definition.name;
        }
      }
      return definitionId;
    },
    readLogFile,
    toRelativePath,
  };
}

/** Yields log content for a model method run. */
export async function* modelMethodHistoryLogs(
  _ctx: LibSwampContext,
  deps: ModelMethodHistoryLogsDeps,
  input: ModelMethodHistoryLogsInput,
): AsyncIterable<ModelMethodHistoryLogsEvent> {
  yield* withGeneratorSpan(
    "swamp.model.method.history.logs",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const reference = input.reference ??
        await resolveOutputReference(deps, input.outputIdOrModelName);
      let output: ModelOutput;
      switch (reference.kind) {
        case "output":
          output = reference.match.output;
          break;
        case "ambiguous":
          yield {
            kind: "error",
            error: validationFailed(
              `Ambiguous ID prefix "${input.outputIdOrModelName}" matches:\n` +
                reference.ids.map((id) => `  ${id}`).join("\n"),
            ),
          };
          return;
        case "not_found":
          yield {
            kind: "error",
            error: {
              code: "not_found",
              message:
                `No method run or model found: ${input.outputIdOrModelName}`,
              details: {
                entityType: "Method run or model",
                idOrName: input.outputIdOrModelName,
              },
            },
          };
          return;
        case "model":
          if (!reference.latest) {
            yield {
              kind: "error",
              error: notFound(
                "Run",
                `for model: ${reference.definition.name}`,
              ),
            };
            return;
          }
          output = reference.latest;
      }

      // Read log file
      if (!output.logFile) {
        const modelName = await deps.getModelName(output.definitionId);
        yield {
          kind: "completed",
          data: {
            type: "no_log_file",
            info: {
              outputId: output.id,
              modelName,
              methodName: output.methodName,
            },
          },
        };
        return;
      }

      const logData = await deps.readLogFile(output.logFile, {
        tail: input.tail,
      });
      const displayPath = deps.toRelativePath(input.repoDir, output.logFile);

      if (logData.lines.length === 0) {
        yield {
          kind: "completed",
          data: {
            type: "empty_log",
            info: {
              outputId: output.id,
              methodName: output.methodName,
              path: displayPath,
            },
          },
        };
        return;
      }

      yield {
        kind: "completed",
        data: {
          type: "log",
          log: { ...logData, path: displayPath },
        },
      };
    })(),
  );
}
