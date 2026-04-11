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
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import {
  type CheckValidationContext,
  DefaultModelValidationService,
  type EnvVarUsageDetail,
} from "../../domain/models/validation_service.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Validation result for a single check. */
export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

/** A warning surfaced during validation (does not cause failure). */
export interface ValidationWarningData {
  name: string;
  message: string;
  envVars?: EnvVarUsageDetail[];
}

/** Validation result for a single model. */
export interface ModelValidateData {
  modelId: string;
  modelName: string;
  type: string;
  validations: ValidationItemData[];
  warnings: ValidationWarningData[];
  passed: boolean;
}

/** Aggregate validation result for all models. */
export interface ModelValidateAllData {
  models: ModelValidateData[];
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
  passed: boolean;
}

export type ModelValidateEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelValidateData | ModelValidateAllData }
  | { kind: "error"; error: SwampError };

export interface ModelValidateInput {
  modelIdOrName?: string;
}

/** Raw validation result from the domain service. */
interface ValidationResult {
  name: string;
  passed: boolean;
  error?: string;
}

/** Raw warning from the domain service. */
interface ValidationWarningResult {
  name: string;
  message: string;
  envVars?: EnvVarUsageDetail[];
}

/** Dependencies for the model validate operation. */
export interface ModelValidateDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findAllDefinitions: () => Promise<
    Array<{ definition: Definition; type: ModelType }>
  >;
  resolveModelType: (
    type: ModelType,
  ) => Promise<unknown | null>;
  validateModel: (
    definition: Definition,
    modelDef: unknown,
    type: ModelType,
  ) => Promise<{
    results: ValidationResult[];
    warnings: ValidationWarningResult[];
  }>;
}

/** Wires real infrastructure into ModelValidateDeps. */
export function createModelValidateDeps(
  repoDir: string,
  options?: { labels?: string[]; method?: string },
  datastoreResolver?: DatastorePathResolver,
): ModelValidateDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
  );
  const dataQueryService = new DataQueryService(catalogStore, dataRepo);
  const validationService = new DefaultModelValidationService();

  const checkContext: CheckValidationContext = {
    repoDir,
    dataRepository: dataRepo,
    definitionRepository: definitionRepo,
    dataQueryService,
    labels: options?.labels,
    method: options?.method,
  };

  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findAllDefinitions: () => definitionRepo.findAllGlobal(),
    resolveModelType: (type) => resolveModelType(type, getAutoResolver()),
    validateModel: async (definition, modelDef, _type) => {
      const outcome = await validationService.validateModel(
        definition,
        // deno-lint-ignore no-explicit-any
        modelDef as any,
        definitionRepo,
        checkContext,
      );
      return {
        results: outcome.results,
        warnings: outcome.warnings.map((w) => ({
          name: w.name,
          message: w.message,
          envVars: w.details,
        })),
      };
    },
  };
}

/** Converts raw validation results to the presentation format. */
function toValidationItemData(
  results: ValidationResult[],
): ValidationItemData[] {
  return results.map((r) => ({
    name: r.name,
    passed: r.passed,
    error: r.error,
  }));
}

/** Converts raw validation warnings to the presentation format. */
function toValidationWarningData(
  warnings: ValidationWarningResult[],
): ValidationWarningData[] {
  return warnings.map((w) => ({
    name: w.name,
    message: w.message,
    envVars: w.envVars,
  }));
}

/** Type guard to check if data is ModelValidateAllData. */
export function isModelValidateAllData(
  data: ModelValidateData | ModelValidateAllData,
): data is ModelValidateAllData {
  return "models" in data;
}

/** Validates all models in the repository. */
async function* validateAll(
  deps: ModelValidateDeps,
): AsyncIterable<ModelValidateEvent> {
  const allDefinitions = await deps.findAllDefinitions();

  if (allDefinitions.length === 0) {
    yield {
      kind: "error",
      error: validationFailed("No models found"),
    };
    return;
  }

  const results: ModelValidateData[] = [];
  for (const { definition, type } of allDefinitions) {
    const modelDef = await deps.resolveModelType(type);
    if (!modelDef) {
      continue;
    }

    const outcome = await deps.validateModel(
      definition,
      modelDef,
      type,
    );

    const validations = toValidationItemData(outcome.results);
    const warnings = toValidationWarningData(outcome.warnings);
    const allPassed = outcome.results.every((r) => r.passed);

    results.push({
      modelId: definition.id,
      modelName: definition.name,
      type: type.normalized,
      validations,
      warnings,
      passed: allPassed,
    });
  }

  const totalPassed = results.filter((m) => m.passed).length;
  const totalFailed = results.length - totalPassed;
  const totalWarnings = results.reduce(
    (sum, m) => sum + m.warnings.length,
    0,
  );

  yield {
    kind: "completed",
    data: {
      models: results,
      totalPassed,
      totalFailed,
      totalWarnings,
      passed: totalFailed === 0,
    },
  };
}

/** Validates a single model. */
async function* validateSingle(
  deps: ModelValidateDeps,
  modelIdOrName: string,
): AsyncIterable<ModelValidateEvent> {
  const result = await deps.lookupDefinition(modelIdOrName);
  if (!result) {
    yield { kind: "error", error: notFound("Model", modelIdOrName) };
    return;
  }
  const { definition, type: modelType } = result;

  const modelDef = await deps.resolveModelType(modelType);
  if (!modelDef) {
    yield {
      kind: "error",
      error: notFound("Model type", modelType.normalized),
    };
    return;
  }

  // Ensure all model types in the repo are resolved so cross-type
  // expression references can be validated (matches validateAll behavior)
  const allDefinitions = await deps.findAllDefinitions();
  for (const { type } of allDefinitions) {
    await deps.resolveModelType(type);
  }

  const outcome = await deps.validateModel(definition, modelDef, modelType);
  const validations = toValidationItemData(outcome.results);
  const warnings = toValidationWarningData(outcome.warnings);
  const allPassed = outcome.results.every((r) => r.passed);

  yield {
    kind: "completed",
    data: {
      modelId: definition.id,
      modelName: definition.name,
      type: modelType.normalized,
      validations,
      warnings,
      passed: allPassed,
    },
  };
}

/** Validates model definitions against their schemas. */
export async function* modelValidate(
  _ctx: LibSwampContext,
  deps: ModelValidateDeps,
  input: ModelValidateInput,
): AsyncIterable<ModelValidateEvent> {
  yield* withGeneratorSpan(
    "swamp.model.validate",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (!input.modelIdOrName) {
        yield* validateAll(deps);
      } else {
        yield* validateSingle(deps, input.modelIdOrName);
      }
    })(),
  );
}
