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
   * Without a model, saves and reports only the models this accepts. Every
   * model is still evaluated, since evaluation orders them all in one
   * dependency graph, but the evaluated definitions of the others are
   * neither written nor returned.
   */
  include?: (entry: { definition: Definition; type: ModelType }) => boolean;
}

/** Type guard to check if data is ModelEvaluateAllData. */
export function isModelEvaluateAllData(
  data: ModelEvaluateItemData | ModelEvaluateAllData,
): data is ModelEvaluateAllData {
  return "items" in data;
}

/** Dependencies for the model evaluate operation. */
export interface ModelEvaluateDeps {
  /** Looks up by name, then by exact id. */
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  /** Looks up by exact id only; required for a `byId` request. */
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
   * The evaluation's sensitive values, with the registry that carries the
   * internal typed-secrets option. Only tests set a typed one
   * (design/enablers/typed-secrets.md Section 10.3): the passes then issue
   * sentinels for every secret they read and the cache is written from them
   * through the persisted form. The CLI and serve pass nothing.
   */
  createSensitiveValues?: () => RunSensitiveValues;
  /**
   * The argument schemas of a model type, so a literal under a sensitive
   * argument is masked in the cache (swamp-club#3681). It must find every
   * type the evaluated repository's guard can find, or the guard refuses
   * what this left unmasked. Undefined for a type no extension registers,
   * which masks nothing; the guard lets such a type through as well.
   */
  lookupModelDefinition: (
    type: ModelType,
  ) => Promise<ArgumentSchemas | undefined>;
  saveEvaluatedDefinition: (
    type: ModelType,
    definition: Definition,
    /** Where data sits in the definition's raw copy (swamp-club#3205). */
    provenance: ProvenanceMap,
    authoredExpressions: ReadonlySet<string>,
    writtenReferences?: readonly WrittenReference[],
    /** Where the definition holds the mask (swamp-club#3681). */
    maskedPaths?: readonly MaskedPath[],
    persistedProvenance?: ProvenanceMap,
  ) => Promise<void>;
  getEvaluatedPath: (type: ModelType, id: DefinitionId) => string;
}

/** Wires real infrastructure into ModelEvaluateDeps. */
export function createModelEvaluateDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDataRepo?: FileSystemUnifiedDataRepository,
  injectedCatalogStore?: CatalogStore,
  injectedDefinitionRepo?: YamlDefinitionRepository,
  /**
   * The repository context's foreign content fetcher, so expressions that
   * read another namespace's data see its attributes (swamp-club#3306). Used
   * only by the repository built here; an injected repository carries its own.
   */
  fetchForeignContent?: ForeignContentFetcher,
  /**
   * The repository context's lookup, so a read of a record the v3 read model
   * could not materialise fails loudly (swamp-club#3617). Used only by the
   * repository built here; an injected repository carries its own.
   */
  unreadableContent?: UnreadableContentLookup,
  /** See {@link ModelEvaluateDeps.createSensitiveValues}; tests only. */
  createSensitiveValues?: () => RunSensitiveValues,
): ModelEvaluateDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(repoDir);
  // When a shared catalog store / data repo is injected (e.g. by serve
  // handlers passing the process-scoped RepositoryContext), reuse it and skip
  // createCatalogStore so we don't open a new file-based SQLite store — and
  // leak its 3 FDs — on every request.
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
    // Loads extensions to find the type when the index does not know it,
    // exactly as the repository's guard does, so whatever the guard can see
    // the mask sees first. Never fetches an extension: evaluate reads every
    // definition in the repo, installed type or not.
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
    createSensitiveValues,
  };
}

/**
 * Saves an evaluation with every sensitive value it read written as the
 * vault reference it came from, and any literal under a sensitive argument
 * as the mask.
 */
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

/** Evaluates all model definitions. */
async function* evaluateAll(
  deps: ModelEvaluateDeps,
  include: (entry: { definition: Definition; type: ModelType }) => boolean =
    () => true,
): AsyncIterable<ModelEvaluateEvent> {
  const sensitiveValues = deps.createSensitiveValues?.() ??
    new RunSensitiveValues();
  const results = (await deps.evaluateAllDefinitions(sensitiveValues)).filter(
    include,
  );
  const items: ModelEvaluateItemData[] = [];

  for (const result of results) {
    await saveWithoutSecrets(deps, result, sensitiveValues);
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
  byId: boolean,
  expectedName?: string,
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
  const sensitiveValues = deps.createSensitiveValues?.() ??
    new RunSensitiveValues();
  const result = await deps.evaluateDefinition(
    definition,
    type,
    sensitiveValues,
  );
  await saveWithoutSecrets(deps, result, sensitiveValues, definition);

  yield {
    kind: "completed",
    data: {
      id: result.definition.id,
      name: result.definition.name,
      type: type.normalized,
      hadExpressions: result.hadExpressions,
      outputPath: deps.getEvaluatedPath(type, result.definition.id),
      // Shown with sensitive values masked; the cache holds references.
      globalArguments: sensitiveValues.masked(
        result.definition.globalArguments,
      ) as Record<string, unknown>,
    },
  };
}

/** Evaluates model definitions, replacing CEL expressions with values. */
export async function* modelEvaluate(
  ctx: LibSwampContext,
  deps: ModelEvaluateDeps,
  input: ModelEvaluateInput,
): AsyncIterable<ModelEvaluateEvent> {
  yield* withUnitOfWork(ctx, async function* () {
    yield { kind: "evaluating" };

    if (!input.modelIdOrName) {
      yield* evaluateAll(deps, input.include);
    } else {
      yield* evaluateSingle(
        deps,
        input.modelIdOrName,
        input.byId ?? false,
        input.expectedName,
      );
    }
  });
}
