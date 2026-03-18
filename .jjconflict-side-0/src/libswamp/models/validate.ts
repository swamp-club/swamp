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
import type { ModelType } from "../../domain/models/model_type.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

/** Validation result for a single check. */
export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

/** Validation result for a single model. */
export interface ModelValidateData {
  modelId: string;
  modelName: string;
  type: string;
  validations: ValidationItemData[];
  passed: boolean;
}

/** Aggregate validation result for all models. */
export interface ModelValidateAllData {
  models: ModelValidateData[];
  totalPassed: number;
  totalFailed: number;
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
  ) => Promise<ValidationResult[]>;
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

    const validationResults = await deps.validateModel(
      definition,
      modelDef,
      type,
    );

    const validations = toValidationItemData(validationResults);
    const allPassed = validationResults.every((r) => r.passed);

    results.push({
      modelId: definition.id,
      modelName: definition.name,
      type: type.normalized,
      validations,
      passed: allPassed,
    });
  }

  const totalPassed = results.filter((m) => m.passed).length;
  const totalFailed = results.length - totalPassed;

  yield {
    kind: "completed",
    data: {
      models: results,
      totalPassed,
      totalFailed,
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

  const results = await deps.validateModel(definition, modelDef, modelType);
  const validations = toValidationItemData(results);
  const allPassed = results.every((r) => r.passed);

  yield {
    kind: "completed",
    data: {
      modelId: definition.id,
      modelName: definition.name,
      type: modelType.normalized,
      validations,
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
  yield { kind: "resolving" };

  if (!input.modelIdOrName) {
    yield* validateAll(deps);
  } else {
    yield* validateSingle(deps, input.modelIdOrName);
  }
}
