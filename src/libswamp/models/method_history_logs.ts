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

import type {
  Definition,
  DefinitionId,
} from "../../domain/definitions/definition.ts";
import type { ModelOutput } from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
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
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

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
}

/** Partial ID match result. */
interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: ModelOutput;
  matches?: Array<{ id: string }>;
}

/** Dependencies for the model method history logs operation. */
export interface ModelMethodHistoryLogsDeps {
  isPartialId: (value: string) => boolean;
  matchOutputByPartialId: (
    idPrefix: string,
  ) => Promise<PartialMatchResult>;
  findDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findLatestOutput: (
    type: ModelType,
    definitionId: string,
  ) => Promise<ModelOutput | null>;
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
export function createModelMethodHistoryLogsDeps(
  repoDir: string,
): ModelMethodHistoryLogsDeps {
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const outputRepo = new YamlOutputRepository(repoDir);
  return {
    isPartialId,
    matchOutputByPartialId: async (idPrefix: string) => {
      const allOutputs = await outputRepo.findAllGlobal();
      const result = matchByPartialId(
        allOutputs.map((o) => ({ id: o.output.id, item: o.output })),
        idPrefix,
      );
      if (result.status === "found") {
        return { status: "found" as const, match: result.match };
      }
      if (result.status === "ambiguous") {
        return {
          status: "ambiguous" as const,
          matches: result.matches.map((m) => ({ id: m.id })),
        };
      }
      return { status: "not_found" as const };
    },
    findDefinition: (idOrName: string) =>
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

      let output: ModelOutput | undefined;

      if (deps.isPartialId(input.outputIdOrModelName)) {
        const result = await deps.matchOutputByPartialId(
          input.outputIdOrModelName,
        );

        if (result.status === "found" && result.match) {
          output = result.match;
        } else if (result.status === "ambiguous" && result.matches) {
          yield {
            kind: "error",
            error: validationFailed(
              `Ambiguous ID prefix "${input.outputIdOrModelName}" matches:\n` +
                result.matches.map((m) => `  ${m.id}`).join("\n"),
            ),
          };
          return;
        }
        // not_found: fall through to model name lookup
      }

      if (!output) {
        const definitionResult = await deps.findDefinition(
          input.outputIdOrModelName,
        );

        if (!definitionResult) {
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
        }

        const latestOutput = await deps.findLatestOutput(
          definitionResult.type,
          definitionResult.definition.id,
        );
        if (!latestOutput) {
          yield {
            kind: "error",
            error: notFound(
              "Run",
              `for model: ${definitionResult.definition.name}`,
            ),
          };
          return;
        }

        output = latestOutput;
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
