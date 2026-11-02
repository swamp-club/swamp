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

import type {
  Definition,
  DefinitionId,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { EvaluatedDefinition } from "../../domain/expressions/expression_evaluation_service.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { ForeignContentFetcher } from "../../domain/data/repositories.ts";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import {
  RunSensitiveValues,
  type WrittenReference,
} from "../../domain/secrets/mod.ts";
import {
  type ArgumentSchemas,
  type MaskedPath,
  persistEvaluatedDefinition,
} from "../../domain/expressions/persisted_evaluation.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { selectLookup } from "../lookup_by_id.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import { behaviorNotFound, type SwampError } from "../errors.ts";
import { ProvenanceMap } from "../../domain/expressions/provenance_map.ts";

export interface ModelEvaluateItemData {
  id: string;
  name: string;
  type: string;
  hadExpressions: boolean;
  outputPath?: string;
  saved?: false;
  globalArguments?: Record<string, unknown>;
}

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
  /**
   * Treat `modelIdOrName` as a definition id the caller already resolved,
   * and look it up by id only, so evaluate acts on the model the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a resource with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * without a model, saves and reports only the models this accepts; every
   * model is still evaluated because they share one dependency graph, but the
   * others' definitions are neither written nor returned
   */
  include?: (entry: { definition: Definition; type: ModelType }) => boolean;
  /**
   * saves only the evaluated definitions this accepts; others are returned
   * unsaved with no output path. A later --last-evaluated run replays what is
   * saved, so serve saves only what the caller may run. Absent, everything is
   * saved
   */
  persist?: (entry: { definition: Definition; type: ModelType }) => boolean;
}

export function isModelEvaluateAllData(
  data: ModelEvaluateItemData | ModelEvaluateAllData,
): data is ModelEvaluateAllData {
  return "items" in data;
}

export interface ModelEvaluateDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  evaluateDefinition: (
    definition: Definition,
    type: ModelType,
    sensitiveValues: RunSensitiveValues,
  ) => Promise<EvaluatedDefinition>;
  evaluateAllDefinitions: (
    sensitiveValues: RunSensitiveValues,
  ) => Promise<EvaluatedDefinition[]>;
  /**
   * argument schemas of a model type, so a literal under a sensitive argument
   * is masked in the cache; must find every type the repository's guard can
   * find, or the guard refuses what was left unmasked
   */
  lookupModelDefinition: (
    type: ModelType,
  ) => Promise<ArgumentSchemas | undefined>;
  saveEvaluatedDefinition: (
    type: ModelType,
    definition: Definition,
    provenance: ProvenanceMap,
    authoredExpressions: ReadonlySet<string>,
    writtenReferences?: readonly WrittenReference[],
    maskedPaths?: readonly MaskedPath[],
    persistedProvenance?: ProvenanceMap,
  ) => Promise<void>;
  getEvaluatedPath: (type: ModelType, id: DefinitionId) => string;
}

export function createModelEvaluateDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDataRepo?: FileSystemUnifiedDataRepository,
  injectedCatalogStore?: CatalogStore,
  injectedDefinitionRepo?: YamlDefinitionRepository,
  /**
   * the repository context's foreign content fetcher, so expressions reading
   * another namespace's data see its attributes; used only by the repository
   * built here
   */
  fetchForeignContent?: ForeignContentFetcher,
  /**
   * the repository context's lookup, so a read of a record the v3 read model
   * could not materialise fails loudly; used only by the repository built here
   */
  unreadableContent?: UnreadableContentLookup,
): ModelEvaluateDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(repoDir);
  // reuse an injected shared catalog store or data repo so each request does
  // not open a new file-based SQLite store and leak its file descriptors
  const catalogStore = injectedCatalogStore ??
    createCatalogStore(repoDir, datastoreResolver);
  const dataRepo = injectedDataRepo ?? new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    undefined,
    undefined,
    namespaceFromResolver(datastoreResolver),
    undefined,
    undefined,
    fetchForeignContent,
    unreadableContent,
  );
  const dataQueryService = new DataQueryService(catalogStore, dataRepo);
  const evaluationService = new ExpressionEvaluationService(
    definitionRepo,
    repoDir,
    { dataRepo, dataQueryService },
  );
  const evaluatedDefRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
  );

  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    lookupDefinitionById: (id, expectedName) =>
      findDefinitionByIdGlobal(definitionRepo, id, expectedName),
    evaluateDefinition: (definition, type, sensitiveValues) =>
      evaluationService.evaluateDefinition(definition, type, sensitiveValues),
    evaluateAllDefinitions: (sensitiveValues) =>
      evaluationService.evaluateAllDefinitions(sensitiveValues),
    // loads extensions to find the type when the index does not know it, as the
    // repository's guard does; never fetches an extension, since evaluate reads
    // every definition whether or not its type is installed
    lookupModelDefinition: (type) => modelRegistry.getOrLoad(type),
    saveEvaluatedDefinition: (
      type,
      definition,
      provenance,
      authoredExpressions,
      writtenReferences,
      maskedPaths,
      persistedProvenance,
    ) =>
      evaluatedDefRepo.save(
        type,
        definition,
        provenance,
        authoredExpressions,
        undefined,
        writtenReferences,
        maskedPaths,
        persistedProvenance,
      ),
    getEvaluatedPath: (type, id) => evaluatedDefRepo.getPath(type, id),
  };
}

async function saveWithoutSecrets(
  deps: ModelEvaluateDeps,
  result: EvaluatedDefinition,
  sensitiveValues: RunSensitiveValues,
  source: Definition = result.sourceDefinition ?? result.definition,
): Promise<void> {
  const schemas = await deps.lookupModelDefinition(result.type) ??
    { methods: {} };
  const persisted = persistEvaluatedDefinition(
    result.definition,
    [],
    source,
    sensitiveValues,
    schemas,
    result.provenance,
  );
  await deps.saveEvaluatedDefinition(
    result.type,
    persisted.definition,
    result.provenance ?? ProvenanceMap.authored(),
    result.authoredExpressions,
    persisted.writtenReferences,
    persisted.maskedPaths,
    persisted.persistedProvenance,
  );
}

async function* evaluateAll(
  deps: ModelEvaluateDeps,
  include: (entry: { definition: Definition; type: ModelType }) => boolean =
    () => true,
  persist: (entry: { definition: Definition; type: ModelType }) => boolean =
    () => true,
): AsyncIterable<ModelEvaluateEvent> {
  const sensitiveValues = new RunSensitiveValues();
  // Decided on each stored definition, the one that would be saved, as the
  // single path decides: a tag can hold an expression, and evaluation must
  // not change what the caller may read or save.
  const results = (await deps.evaluateAllDefinitions(sensitiveValues)).flatMap(
    (result) => {
      const stored = {
        definition: result.sourceDefinition ?? result.definition,
        type: result.type,
      };
      return include(stored) ? [{ result, save: persist(stored) }] : [];
    },
  );
  const items: ModelEvaluateItemData[] = [];

  for (const { result, save } of results) {
    const item: ModelEvaluateItemData = {
      id: result.definition.id,
      name: result.definition.name,
      type: result.type.normalized,
      hadExpressions: result.hadExpressions,
    };
    if (save) {
      await saveWithoutSecrets(deps, result, sensitiveValues);
      item.outputPath = deps.getEvaluatedPath(
        result.type,
        result.definition.id,
      );
    } else {
      item.saved = false;
    }
    items.push(item);
  }

  yield {
    kind: "completed",
    data: {
      items,
      total: results.length,
      evaluated: results.filter(({ result }) => result.hadExpressions)
        .length,
    },
  };
}

async function* evaluateSingle(
  deps: ModelEvaluateDeps,
  modelIdOrName: string,
  byId: boolean,
  expectedName?: string,
  persist: (entry: { definition: Definition; type: ModelType }) => boolean =
    () => true,
): AsyncIterable<ModelEvaluateEvent> {
  const lookupDefinition = selectLookup(
    "model evaluate",
    byId,
    deps.lookupDefinition,
    deps.lookupDefinitionById,
    expectedName,
  );
  const lookupResult = await lookupDefinition(modelIdOrName);
  if (!lookupResult) {
    yield { kind: "error", error: behaviorNotFound(modelIdOrName) };
    return;
  }

  const { definition, type } = lookupResult;
  // Decided on the stored definition, the one that would be saved, before
  // evaluation can touch it.
  const save = persist(lookupResult);
  const sensitiveValues = new RunSensitiveValues();
  const result = await deps.evaluateDefinition(
    definition,
    type,
    sensitiveValues,
  );
  if (save) {
    await saveWithoutSecrets(deps, result, sensitiveValues, definition);
  }

  yield {
    kind: "completed",
    data: {
      id: result.definition.id,
      name: result.definition.name,
      type: type.normalized,
      hadExpressions: result.hadExpressions,
      ...(save
        ? { outputPath: deps.getEvaluatedPath(type, result.definition.id) }
        : { saved: false as const }),
      // Shown with sensitive values masked; the cache holds references.
      globalArguments: sensitiveValues.masked(
        result.definition.globalArguments,
      ) as Record<string, unknown>,
    },
  };
}

export async function* modelEvaluate(
  ctx: LibSwampContext,
  deps: ModelEvaluateDeps,
  input: ModelEvaluateInput,
): AsyncIterable<ModelEvaluateEvent> {
  yield* withUnitOfWork(ctx, async function* () {
    yield { kind: "evaluating" };

    if (!input.modelIdOrName) {
      yield* evaluateAll(deps, input.include, input.persist);
    } else {
      yield* evaluateSingle(
        deps,
        input.modelIdOrName,
        input.byId ?? false,
        input.expectedName,
        input.persist,
      );
    }
  });
}
