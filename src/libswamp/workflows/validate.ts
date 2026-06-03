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

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowValidationResult } from "../../domain/workflows/validation_service.ts";
import {
  DefaultWorkflowValidationService,
  type MethodResolution,
  type ModelMethodResolver,
} from "../../domain/workflows/validation_service.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { zodToJsonSchema } from "../types/schema_helpers.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** UUID v4 regex pattern for detecting if an argument is a UUID. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Checks if a string looks like a UUID. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Validation result for a single check. */
export interface ValidationItemData {
  name: string;
  passed: boolean;
  warning?: boolean;
  error?: string;
}

/** Validation result for a single workflow. */
export interface WorkflowValidateData {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  totalWarnings: number;
  passed: boolean;
}

/** Aggregate validation result for all workflows. */
export interface WorkflowValidateAllData {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
  passed: boolean;
}

export type WorkflowValidateEvent =
  | { kind: "resolving" }
  | {
    kind: "completed";
    data: WorkflowValidateData | WorkflowValidateAllData;
  }
  | { kind: "error"; error: SwampError };

export interface WorkflowValidateInput {
  workflowIdOrName?: string;
}

/** Dependencies for the workflow validate operation. */
export interface WorkflowValidateDeps {
  findWorkflowById: (id: string) => Promise<Workflow | null>;
  findWorkflowByName: (name: string) => Promise<Workflow | null>;
  findAllWorkflows: () => Promise<Workflow[]>;
  validate: (workflow: Workflow) => Promise<WorkflowValidationResult[]>;
}

/**
 * Creates a ModelMethodResolver that uses the definition repository and
 * extension auto-resolver to look up method argument schemas.
 */
function createModelMethodResolver(
  definitionRepo: YamlDefinitionRepository,
): ModelMethodResolver {
  return {
    async resolve(modelIdOrName, methodName, modelTypeArg?) {
      if (modelTypeArg) {
        return resolveByType(modelTypeArg, methodName);
      }

      const lookupResult = await findDefinitionByIdOrName(
        definitionRepo,
        modelIdOrName,
      );
      if (!lookupResult) {
        return { status: "model_not_found" };
      }

      const { type: modelType } = lookupResult;
      const modelDef = await resolveModelType(modelType, getAutoResolver());
      if (!modelDef) {
        return { status: "type_unresolvable", modelType: modelType.normalized };
      }

      const method = modelDef.methods[methodName];
      if (!method) {
        return { status: "method_not_found", modelType: modelType.normalized };
      }

      // Extract required fields from the method's Zod argument schema
      const jsonSchema = zodToJsonSchema(method.arguments) as {
        required?: string[];
      };
      const requiredArgs = jsonSchema.required ?? [];

      // Arguments the definition already supplies — runtime merges these as
      // fallbacks under step-level inputs (see DefaultMethodExecutionService).
      // The validator treats any defined key as "present" regardless of value,
      // including unresolved ${{ ... }} expressions: invalid CEL is a runtime
      // concern, not a validator concern.
      const { definition } = lookupResult;
      const definitionProvidedArgs = Array.from(
        new Set([
          ...Object.keys(definition.getMethodArguments(methodName)),
          ...Object.keys(definition.globalArguments),
        ]),
      );

      return { status: "resolved", requiredArgs, definitionProvidedArgs };
    },
  };
}

async function resolveByType(
  typeArg: string,
  methodName: string,
): Promise<MethodResolution> {
  const type = ModelType.create(typeArg);
  const modelDef = await resolveModelType(type, getAutoResolver());
  if (!modelDef) {
    return { status: "type_unresolvable", modelType: type.normalized };
  }

  const method = modelDef.methods[methodName];
  if (!method) {
    return { status: "method_not_found", modelType: type.normalized };
  }

  const methodSchema = zodToJsonSchema(method.arguments) as {
    required?: string[];
  };
  const methodRequired = methodSchema.required ?? [];

  const globalRequired: string[] = [];
  if (modelDef.globalArguments) {
    const globalSchema = zodToJsonSchema(modelDef.globalArguments) as {
      required?: string[];
    };
    globalRequired.push(...(globalSchema.required ?? []));
  }

  const requiredArgs = Array.from(
    new Set([...methodRequired, ...globalRequired]),
  );

  return { status: "resolved", requiredArgs };
}

/** Wires real infrastructure into WorkflowValidateDeps. */
export function createWorkflowValidateDeps(
  workflowRepo: WorkflowRepository,
  definitionRepo?: YamlDefinitionRepository,
): WorkflowValidateDeps {
  const methodResolver = definitionRepo
    ? createModelMethodResolver(definitionRepo)
    : undefined;
  const validationService = new DefaultWorkflowValidationService(
    methodResolver,
    definitionRepo ? workflowRepo : undefined,
  );
  return {
    findWorkflowById: (id) => workflowRepo.findById(createWorkflowId(id)),
    findWorkflowByName: (name) => workflowRepo.findByName(name),
    findAllWorkflows: () => workflowRepo.findAll(),
    validate: (workflow) => validationService.validate(workflow),
  };
}

/** Converts raw results to presentation format. */
function toValidationItemData(
  results: WorkflowValidationResult[],
): ValidationItemData[] {
  return results.map((r) => ({
    name: r.name,
    passed: r.passed,
    ...(r.warning ? { warning: true } : {}),
    error: r.error,
  }));
}

/** Type guard to check if data is WorkflowValidateAllData. */
export function isWorkflowValidateAllData(
  data: WorkflowValidateData | WorkflowValidateAllData,
): data is WorkflowValidateAllData {
  return "workflows" in data;
}

/** Validates all workflows. */
async function* validateAll(
  deps: WorkflowValidateDeps,
): AsyncIterable<WorkflowValidateEvent> {
  const allWorkflows = await deps.findAllWorkflows();

  if (allWorkflows.length === 0) {
    yield {
      kind: "error",
      error: validationFailed("No workflows found"),
    };
    return;
  }

  const results: WorkflowValidateData[] = [];
  for (const workflow of allWorkflows) {
    const validationResults = await deps.validate(workflow);
    const validations = toValidationItemData(validationResults);
    const allPassed = validationResults.every((r) => r.passed);
    const warningCount = validationResults.filter((r) => r.warning).length;

    results.push({
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
      totalWarnings: warningCount,
      passed: allPassed,
    });
  }

  const totalPassed = results.filter((w) => w.passed).length;
  const totalFailed = results.length - totalPassed;
  const totalWarnings = results.reduce((sum, w) => sum + w.totalWarnings, 0);

  yield {
    kind: "completed",
    data: {
      workflows: results,
      totalPassed,
      totalFailed,
      totalWarnings,
      passed: totalFailed === 0,
    },
  };
}

/** Validates a single workflow. */
async function* validateSingle(
  deps: WorkflowValidateDeps,
  workflowIdOrName: string,
): AsyncIterable<WorkflowValidateEvent> {
  let workflow: Workflow | null = null;

  if (isUuid(workflowIdOrName)) {
    workflow = await deps.findWorkflowById(workflowIdOrName);
  } else {
    workflow = await deps.findWorkflowByName(workflowIdOrName);
  }

  if (!workflow) {
    yield {
      kind: "error",
      error: notFound("Workflow", workflowIdOrName),
    };
    return;
  }

  const results = await deps.validate(workflow);
  const validations = toValidationItemData(results);
  const allPassed = results.every((r) => r.passed);
  const warningCount = results.filter((r) => r.warning).length;

  yield {
    kind: "completed",
    data: {
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
      totalWarnings: warningCount,
      passed: allPassed,
    },
  };
}

/** Validates workflow definitions against their schemas. */
export async function* workflowValidate(
  _ctx: LibSwampContext,
  deps: WorkflowValidateDeps,
  input: WorkflowValidateInput,
): AsyncIterable<WorkflowValidateEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.validate",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (!input.workflowIdOrName) {
        yield* validateAll(deps);
      } else {
        yield* validateSingle(deps, input.workflowIdOrName);
      }
    })(),
  );
}
