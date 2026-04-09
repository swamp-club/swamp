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
import type { ModelType } from "../../domain/models/model_type.ts";
import type { EvaluatedDefinition } from "../../domain/expressions/expression_evaluation_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError } from "../errors.ts";

/** Evaluation result for a single model. */
export interface ModelEvaluateItemData {
  id: string;
  name: string;
  type: string;
  hadExpressions: boolean;
  outputPath?: string;
  globalArguments?: Record<string, unknown>;
}

/** Aggregate evaluation result for all models. */
export interface ModelEvaluateAllData {
  items: ModelEvaluateItemData[];
  total: number;
  evaluated: number;
}

export type ModelEvaluateEvent =
  | { kind: "evaluating" }
  | { kind: "completed"; data: ModelEvaluateItemData | ModelEvaluateAllData }
  | { kind: "error"; error: SwampError };

export interface ModelEvaluateInput {
  modelIdOrName?: string;
}

/** Type guard to check if data is ModelEvaluateAllData. */
export function isModelEvaluateAllData(
  data: ModelEvaluateItemData | ModelEvaluateAllData,
): data is ModelEvaluateAllData {
  return "items" in data;
}

/** Dependencies for the model evaluate operation. */
export interface ModelEvaluateDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  evaluateDefinition: (
    definition: Definition,
    type: ModelType,
  ) => Promise<EvaluatedDefinition>;
  evaluateAllDefinitions: () => Promise<EvaluatedDefinition[]>;
  saveEvaluatedDefinition: (
    type: ModelType,
    definition: Definition,
  ) => Promise<void>;
  getEvaluatedPath: (type: ModelType, id: DefinitionId) => string;
}

/** Wires real infrastructure into ModelEvaluateDeps. */
export function createModelEvaluateDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): ModelEvaluateDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
  );
  const evaluationService = new ExpressionEvaluationService(
    definitionRepo,
    repoDir,
    { dataRepo },
  );
  const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
  );

  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    evaluateDefinition: (definition, type) =>
      evaluationService.evaluateDefinition(definition, type),
    evaluateAllDefinitions: () => evaluationService.evaluateAllDefinitions(),
    saveEvaluatedDefinition: (type, definition) =>
      evaluatedDefRepo.save(type, definition),
    getEvaluatedPath: (type, id) => evaluatedDefRepo.getPath(type, id),
  };
}

/** Evaluates all model definitions. */
async function* evaluateAll(
  deps: ModelEvaluateDeps,
): AsyncIterable<ModelEvaluateEvent> {
  const results = await deps.evaluateAllDefinitions();
  const items: ModelEvaluateItemData[] = [];

  for (const result of results) {
    await deps.saveEvaluatedDefinition(result.type, result.definition);
    items.push({
      id: result.definition.id,
      name: result.definition.name,
      type: result.type.normalized,
      hadExpressions: result.hadExpressions,
      outputPath: deps.getEvaluatedPath(result.type, result.definition.id),
    });
  }

  yield {
    kind: "completed",
    data: {
      items,
      total: results.length,
      evaluated: results.filter((r) => r.hadExpressions).length,
    },
  };
}

/** Evaluates a single model definition. */
async function* evaluateSingle(
  deps: ModelEvaluateDeps,
  modelIdOrName: string,
): AsyncIterable<ModelEvaluateEvent> {
  const lookupResult = await deps.lookupDefinition(modelIdOrName);
  if (!lookupResult) {
    yield { kind: "error", error: notFound("Model", modelIdOrName) };
    return;
  }

  const { definition, type } = lookupResult;
  const result = await deps.evaluateDefinition(definition, type);
  await deps.saveEvaluatedDefinition(type, result.definition);

  yield {
    kind: "completed",
    data: {
      id: result.definition.id,
      name: result.definition.name,
      type: type.normalized,
      hadExpressions: result.hadExpressions,
      outputPath: deps.getEvaluatedPath(type, result.definition.id),
      globalArguments: result.definition.globalArguments,
    },
  };
}

/** Evaluates model definitions, replacing CEL expressions with values. */
export async function* modelEvaluate(
  _ctx: LibSwampContext,
  deps: ModelEvaluateDeps,
  input: ModelEvaluateInput,
): AsyncIterable<ModelEvaluateEvent> {
  yield { kind: "evaluating" };

  if (!input.modelIdOrName) {
    yield* evaluateAll(deps);
  } else {
    yield* evaluateSingle(deps, input.modelIdOrName);
  }
}
