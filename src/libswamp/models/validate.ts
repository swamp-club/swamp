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
import { markModelWording, wordedText } from "../../domain/behavior_wording.ts";
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import {
  type CheckArgumentDelivery,
  type CheckValidationContext,
  DefaultModelValidationService,
  type EnvVarUsageDetail,
  type ExpressionPathError,
  type ForeignTemplateDetail,
} from "../../domain/models/validation_service.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { createExtensionCelEnvironment } from "../../infrastructure/cel/cel_evaluator.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { ForeignContentFetcher } from "../../domain/data/repositories.ts";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { selectLookup } from "../lookup_by_id.ts";
import type { LibSwampContext } from "../context.ts";
import {
  behaviorNotFound,
  behaviorTypeNotFound,
  type SwampError,
  wordedSwampError,
} from "../errors.ts";

import {
  collectAuthoredExpressions,
  ExpressionEvaluationService,
} from "../../domain/expressions/expression_evaluation_service.ts";
import {
  deliverStepSecrets,
  unresolvedArgumentsOf,
} from "../../domain/models/method_execution_service.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { RunSensitiveValues } from "../../domain/secrets/run_sensitive_values.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { diagnoseSecretMisuse } from "../../infrastructure/cel/secret_diagnostics.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Validation result for a single check. */
export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
  /** The failed expressions behind an `Expression paths` failure. */
  expressionErrors?: readonly ExpressionPathError[];
}

/** A warning surfaced during validation (does not cause failure). */
export interface ValidationWarningData {
  name: string;
  message: string;
  envVars?: EnvVarUsageDetail[];
  /** Another service's template syntax, passed to the method unchanged. */
  templates?: ForeignTemplateDetail[];
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
  /**
   * Treat `modelIdOrName` as a definition id the caller already resolved,
   * and look it up by id only, so validate acts on the model the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a resource with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * Without a model, validates only the models this accepts; the others are
   * neither validated nor reported. Every model's type is still resolved,
   * so cross-type references validate as they would without it.
   */
  include?: (entry: { definition: Definition; type: ModelType }) => boolean;
}

/** Raw validation result from the domain service. */
interface ValidationResult {
  name: string;
  passed: boolean;
  error?: string;
  expressionErrors?: readonly ExpressionPathError[];
  /** `error` in model words (swamp-club#3437). */
  modelError?: string;
}

/** Raw warning from the domain service. */
interface ValidationWarningResult {
  name: string;
  message: string;
  envVars?: EnvVarUsageDetail[];
  templates?: ForeignTemplateDetail[];
  /** The message in model words (swamp-club#3437). */
  modelMessage?: string;
}

/**
 * Note on a definition swamp wrote itself (swamp-club#2496). One a workflow
 * step wrote from its arguments holds the values that step evaluated, so its
 * findings can be text evaluation produced rather than an author's mistake.
 */
const AUTO_DEFINITION_NOTE: ValidationWarningData = {
  name: "Auto-definition",
  message:
    "This definition was written by swamp from a run's evaluated arguments, so these findings may be text that evaluation produced rather than mistakes. If a change is needed, make it in the workflow step or command that wrote the definition, not in this file.",
};

/** Dependencies for the model validate operation. */
export interface ModelValidateDeps {
  /** Looks up by name, then by exact id. */
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  /** Looks up by exact id only; required for a `byId` request. */
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findAllDefinitions: () => Promise<
    Array<{ definition: Definition; type: ModelType }>
  >;
  /**
   * Whether a definition `lookupDefinition` returned was loaded from the
   * auto-definitions directory, which swamp writes itself, rather than from
   * `models/`.
   */
  isAutoDefinition: (
    definition: Definition,
    type: ModelType,
  ) => Promise<boolean>;
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
  options?: {
    labels?: string[];
    method?: string;
    /**
     * The sensitive values of this validation, with the registry that
     * carries the internal typed-secrets option. Only tests set a typed
     * one (design/enablers/typed-secrets.md Section 10.3): it turns on the
     * Secret usage diagnostics and delivers the pre-flight check arguments
     * through the shared refuse-then-load step. The CLI passes nothing.
     */
    createSensitiveValues?: () => RunSensitiveValues;
  },
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
): ModelValidateDeps {
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
  const validationService = new DefaultModelValidationService();
  const expressionService = new ExpressionEvaluationService(
    definitionRepo,
    repoDir,
    { dataRepo, dataQueryService },
  );

  // A typed registry (the internal option, set only by tests) turns on the
  // Secret usage diagnostics and the shared pre-flight delivery below; an
  // untyped one leaves validate as it was (typed-secrets 3.5).
  const sensitiveValues = options?.createSensitiveValues?.() ??
    new RunSensitiveValues();
  const typed = sensitiveValues.sentinels.typedSecrets;

  const checkContext: CheckValidationContext = {
    repoDir,
    dataRepository: dataRepo,
    definitionRepository: definitionRepo,
    dataQueryService,
    createCelEnvironment: createExtensionCelEnvironment,
    // Checks run against definitions loaded straight from the repository, with
    // no CEL substitution applied, so every expression in them is author-written.
    // In a typed run the shared delivery step replaces this inline resolution.
    resolveRuntimeExpressions: typed
      ? undefined
      : (data) =>
        expressionService.resolveRuntimeExpressionsInData(
          data,
          undefined,
          undefined,
          "unrestricted",
        ),
    labels: options?.labels,
    method: options?.method,
  };

  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    lookupDefinitionById: (id, expectedName) =>
      findDefinitionByIdGlobal(definitionRepo, id, expectedName),
    findAllDefinitions: () => definitionRepo.findAllGlobal(),
    isAutoDefinition: (definition, type) =>
      definitionRepo.isAutoDefinition(definition, type),
    resolveModelType: (type) => resolveModelType(type, getAutoResolver()),
    validateModel: async (definition, modelDef, type) => {
      const model = modelDef as ModelDefinition;
      const file = definitionRepo.getPath(type, definition.id);
      const outcome = await validationService.validateModel(
        definition,
        model,
        definitionRepo,
        typed
          ? {
            ...checkContext,
            deliverCheckArguments: (stored, methodName) =>
              deliverCheckArguments(
                stored,
                model,
                methodName,
                expressionService,
                sensitiveValues,
              ),
          }
          : checkContext,
        // Definitions are read straight from the repository, as stored.
        {
          refuseLiteralSensitiveGlobals: true,
          ...(typed
            ? {
              // Each finding names the definition file beside its authored
              // location (design Section 10.2).
              diagnoseSecretMisuse: (expression, location) =>
                diagnoseSecretMisuse(expression, location).map((finding) => ({
                  ...finding,
                  location: `${file} ${finding.location}`,
                })),
            }
            : {}),
        },
      );
      return {
        results: outcome.results,
        warnings: outcome.warnings.map((w) => ({
          name: w.name,
          message: w.message,
          envVars: w.details,
          templates: w.templates,
          modelMessage: w.modelMessage,
        })),
      };
    },
  };
}

/**
 * What the pre-flight checks of a typed validation receive, through the
 * same delivery a method boundary performs (design/enablers/typed-secrets.md
 * Sections 3.3 and 6.3): the runtime pass checks every vault.get reference
 * of the stored definition and issues it into a bag of the validation's
 * registry; the shared step then refuses a secret at a destination that
 * takes none and loads the references the arguments carry, once. The
 * checks see the global arguments with their values, the merge with its
 * sentinels as `unresolvedMethodArgs`, and the loaded bag.
 */
async function deliverCheckArguments(
  definition: Definition,
  modelDef: ModelDefinition,
  methodName: string,
  expressionService: ExpressionEvaluationService,
  sensitiveValues: RunSensitiveValues,
): Promise<CheckArgumentDelivery> {
  const { definition: resolved, secretBag } = await expressionService
    .resolveRuntimeExpressionsInDefinition(
      definition,
      sensitiveValues.probeRedactor,
      undefined,
      collectAuthoredExpressions(definition.toData()),
      { secretBag: new VaultSecretBag(sensitiveValues.sentinels) },
    );
  const delivery = await deliverStepSecrets({
    definition: resolved,
    modelDef,
    method: methodName ? modelDef.methods[methodName] : undefined,
    methodName,
    vaultSecrets: secretBag,
    secretLoader: expressionService.secretLoader(sensitiveValues.probeRedactor),
    localPlacement: true,
  });
  const loaded = delivery.vaultSecrets;
  return {
    globalArgs: loaded?.resolvesAny
      ? loaded.resolveDeep(resolved.globalArguments) as Record<string, unknown>
      : resolved.globalArguments,
    unresolvedMethodArgs: delivery.sentinelArguments ??
      unresolvedArgumentsOf(resolved, methodName),
    vaultSecrets: loaded,
  };
}

/** Converts raw validation results to the presentation format. */
function toValidationItemData(
  results: ValidationResult[],
): ValidationItemData[] {
  return results.map((r) => {
    const data: ValidationItemData = {
      name: r.name,
      passed: r.passed,
      error: r.error,
      expressionErrors: r.expressionErrors,
    };
    // A hidden marker holding `error` in model words, so the JSON shape is
    // unchanged (swamp-club#3437). Each expression error carries its own; see
    // expressionPathErrorInModelWords.
    return r.modelError === undefined || r.modelError === r.error
      ? data
      : markModelWording(data, r.modelError);
  });
}

/** Converts raw validation warnings to the presentation format. */
function toValidationWarningData(
  warnings: ValidationWarningResult[],
): ValidationWarningData[] {
  return warnings.map((w) => {
    const data: ValidationWarningData = {
      name: w.name,
      message: w.message,
      envVars: w.envVars,
      templates: w.templates,
    };
    // A hidden marker, so the JSON shape is unchanged (swamp-club#3437).
    return w.modelMessage === undefined
      ? data
      : markModelWording(data, w.modelMessage);
  });
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
  include: (entry: { definition: Definition; type: ModelType }) => boolean =
    () => true,
): AsyncIterable<ModelValidateEvent> {
  const allDefinitions = await deps.findAllDefinitions();

  const accepted = new Set(allDefinitions.filter(include));
  if (accepted.size === 0) {
    yield {
      kind: "error",
      error: wordedSwampError(
        "validation_failed",
        wordedText((w) => `No ${w.nouns} found`),
      ),
    };
    return;
  }

  const results: ModelValidateData[] = [];
  for (const entry of allDefinitions) {
    const { definition, type } = entry;
    const modelDef = await deps.resolveModelType(type);
    if (!modelDef || !accepted.has(entry)) {
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
  byId: boolean,
  expectedName?: string,
): AsyncIterable<ModelValidateEvent> {
  const lookupDefinition = selectLookup(
    "model validate",
    byId,
    deps.lookupDefinition,
    deps.lookupDefinitionById,
    expectedName,
  );
  const result = await lookupDefinition(modelIdOrName);
  if (!result) {
    yield { kind: "error", error: behaviorNotFound(modelIdOrName) };
    return;
  }
  const { definition, type: modelType } = result;

  const modelDef = await deps.resolveModelType(modelType);
  if (!modelDef) {
    yield {
      kind: "error",
      error: behaviorTypeNotFound(modelType.normalized),
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
  // Only when there is a finding to explain: a clean auto-definition needs no
  // note, and would otherwise report a warning for nothing.
  const allPassed = outcome.results.every((r) => r.passed);
  const hasFindings = !allPassed || warnings.length > 0;
  // Only reached with findings, so an auto-definition's walk of models/ is
  // paid only when the note has something to explain.
  if (hasFindings && await deps.isAutoDefinition(definition, modelType)) {
    warnings.push({ ...AUTO_DEFINITION_NOTE });
  }

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
        yield* validateAll(deps, input.include);
      } else {
        yield* validateSingle(
          deps,
          input.modelIdOrName,
          input.byId ?? false,
          input.expectedName,
        );
      }
    })(),
  );
}
