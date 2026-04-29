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

import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowValidationResult } from "../../domain/workflows/validation_service.ts";
import {
  DefaultWorkflowValidationService,
  type ModelMethodResolver,
} from "../../domain/workflows/validation_service.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";
import { findClosestMatch } from "../../domain/string_distance.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
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
  error?: string;
}

/** Validation result for a single workflow. */
export interface WorkflowValidateData {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  passed: boolean;
}

/** Aggregate validation result for all workflows. */
export interface WorkflowValidateAllData {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
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
    async resolve(modelIdOrName, methodName) {
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
        return {
          status: "method_not_found",
          modelType: modelType.normalized,
          availableMethods: Object.keys(modelDef.methods),
        };
      }

      // Extract required fields and per-argument types from the method's
      // Zod schema. The types are surfaced in error messages so a missing
      // input failure tells the agent both *what* is missing and *what
      // type* to provide.
      const jsonSchema = zodToJsonSchema(method.arguments) as {
        required?: string[];
        properties?: Record<string, { type?: string }>;
      };
      const requiredArgs = jsonSchema.required ?? [];
      const argTypes: Record<string, string> = {};
      for (const [name, prop] of Object.entries(jsonSchema.properties ?? {})) {
        argTypes[name] = prop.type ?? "unknown";
      }

      return { status: "resolved", requiredArgs, argTypes };
    },
  };
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

    results.push({
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
      passed: allPassed,
    });
  }

  const totalPassed = results.filter((w) => w.passed).length;
  const totalFailed = results.length - totalPassed;

  yield {
    kind: "completed",
    data: {
      workflows: results,
      totalPassed,
      totalFailed,
      passed: totalFailed === 0,
    },
  };
}

/**
 * Builds an enriched not-found error with actionable suggestions.
 * Matters because the bench transcript shows agents burning many turns
 * here — guessing at the right invocation when the workflow doesn't
 * exist yet, or passing a file path instead of a name. A targeted
 * error message turns flailing into a one-shot.
 */
async function buildWorkflowNotFoundError(
  workflowIdOrName: string,
  deps: WorkflowValidateDeps,
): Promise<SwampError> {
  // Common agent mistake: passing a file path to validate.
  const looksLikeFilePath = workflowIdOrName.endsWith(".yaml") ||
    workflowIdOrName.endsWith(".yml") ||
    workflowIdOrName.includes("/");
  if (looksLikeFilePath) {
    return validationFailed(
      `'${workflowIdOrName}' looks like a file path. ` +
        `\`swamp workflow validate\` takes a workflow name or ID, not a file. ` +
        `If the file isn't yet registered with swamp, run ` +
        `\`swamp workflow create <name>\` first (this scaffolds a YAML and ` +
        `assigns its UUID), edit the scaffold, then validate by name.`,
      { entityType: "Workflow", idOrName: workflowIdOrName },
    );
  }

  // Otherwise, suggest closest existing name and list a few examples.
  const all = await deps.findAllWorkflows();
  const names = all.map((w) => w.name);

  if (names.length === 0) {
    return validationFailed(
      `Workflow '${workflowIdOrName}' not found. No workflows exist in this ` +
        `repo. Create one with \`swamp workflow create ${workflowIdOrName}\`, ` +
        `then edit the scaffold it produces.`,
      { entityType: "Workflow", idOrName: workflowIdOrName },
    );
  }

  const closest = findClosestMatch(workflowIdOrName, names);
  let detail = `Workflow '${workflowIdOrName}' not found.`;
  if (closest) {
    detail += ` Did you mean '${closest}'?`;
  }
  const sample = names.slice(0, 8);
  detail += ` Existing workflows: ${sample.join(", ")}` +
    (names.length > 8 ? ` (+${names.length - 8} more)` : "") +
    `. Run \`swamp workflow search\` for the full list.`;

  return validationFailed(detail, {
    entityType: "Workflow",
    idOrName: workflowIdOrName,
  });
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
      error: await buildWorkflowNotFoundError(workflowIdOrName, deps),
    };
    return;
  }

  const results = await deps.validate(workflow);
  const validations = toValidationItemData(results);
  const allPassed = results.every((r) => r.passed);

  yield {
    kind: "completed",
    data: {
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
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
