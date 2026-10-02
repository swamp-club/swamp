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

import { UserError } from "../../domain/errors.ts";
import type { JobData } from "../../domain/workflows/job.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import {
  containsExpression,
  extractExpressions,
  isAssertExprPath,
  isAssertMessagePath,
  isGuardPath,
  isTaskGlobalArgsPath,
  isTaskInputsPath,
  replaceExpressions,
} from "../../domain/expressions/expression_parser.ts";
import { maskLiteralCalls } from "../../domain/expressions/cel_string_lexer.ts";
import { scanExpressions } from "../../domain/expressions/expression_scanner.ts";
import {
  containsRuntimeExpression,
} from "../../domain/expressions/expression_evaluation_service.ts";
import {
  collectWorkflowAuthoredExpressions,
  createTaskTargetDeferral,
} from "../../domain/workflows/expression_evaluators.ts";
import { resolveAvailableExpressions } from "../../domain/expressions/available_expression_resolver.ts";
import {
  hasStepOutputDependency,
  hasStepsNamespaceReference,
  requiresModelNamespace,
} from "../../domain/expressions/dependency_extractor.ts";
import type { ExpressionContext } from "../../domain/expressions/model_resolver.ts";
import { ModelResolver } from "../../domain/expressions/model_resolver.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import {
  RunSensitiveValues,
  type WrittenReference,
} from "../../domain/secrets/mod.ts";
import {
  forEachNameWithoutSecrets,
  persistEvaluatedWorkflow,
} from "../../domain/workflows/persisted_workflow.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError } from "../errors.ts";
import { coerceInputTypes } from "../../domain/inputs/mod.ts";

/** Evaluation result for a single workflow. */
export interface WorkflowEvaluateItemData {
  id: string;
  name: string;
  hadExpressions: boolean;
  forEachExpanded?: boolean;
  outputPath?: string;
  jobs?: JobData[];
}

/** Aggregate evaluation result for all workflows. */
export interface WorkflowEvaluateAllData {
  items: WorkflowEvaluateItemData[];
  total: number;
  evaluated: number;
}

export type WorkflowEvaluateEvent =
  | { kind: "evaluating" }
  | {
    kind: "completed";
    data: WorkflowEvaluateItemData | WorkflowEvaluateAllData;
  }
  | { kind: "error"; error: SwampError };

export interface WorkflowEvaluateInput {
  workflowIdOrName?: string;
  inputs: Record<string, unknown>;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved,
   * and look it up by id only, so evaluate acts on the workflow the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a workflow with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * Without a workflow, evaluates and reports only the workflows this
   * accepts. Each workflow evaluates on its own, so the others are skipped.
   */
  include?: (
    workflow: { name: string; tags: Record<string, string> },
  ) => boolean;
}

/** Type guard to check if data is WorkflowEvaluateAllData. */
export function isWorkflowEvaluateAllData(
  data: WorkflowEvaluateItemData | WorkflowEvaluateAllData,
): data is WorkflowEvaluateAllData {
  return "items" in data;
}

/** Dependencies for the workflow evaluate operation. */
export interface WorkflowEvaluateDeps {
  findWorkflowById: (id: WorkflowId) => Promise<Workflow | null>;
  findWorkflowByName: (name: string) => Promise<Workflow | null>;
  findAllWorkflows: () => Promise<Workflow[]>;
  /**
   * Builds the evaluation context. Loading every model definition is only
   * needed when the workflow reads the model or file namespaces.
   */
  buildExpressionContext: (
    needsModelNamespace: boolean,
    sensitiveValues: RunSensitiveValues,
  ) => Promise<ExpressionContext>;
  evaluateCel: (
    expression: string,
    context: Record<string, unknown>,
  ) => unknown;
  /**
   * Async CEL evaluator used by the forEach.in expansion path so
   * data.* helpers (which return Promises) resolve before iteration.
   */
  evaluateCelAsync: (
    expression: string,
    context: Record<string, unknown>,
  ) => Promise<unknown>;
  saveEvaluatedWorkflow: (
    workflow: Workflow,
    authoredExpressions: ReadonlySet<string>,
    writtenReferences?: readonly WrittenReference[],
  ) => Promise<void>;
  getEvaluatedPath: (id: WorkflowId) => string;
}

/** Wires real infrastructure into WorkflowEvaluateDeps. */
export function createWorkflowEvaluateDeps(
  repoDir: string,
  workflowRepo: WorkflowRepository,
  datastoreResolver?: DatastorePathResolver,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): WorkflowEvaluateDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(repoDir);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    undefined,
    undefined,
    namespaceFromResolver(datastoreResolver),
  );
  const dataQueryService = new DataQueryService(catalogStore, dataRepo);
  const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.workflowsEvaluated),
  );
  const modelResolver = new ModelResolver(definitionRepo, {
    repoDir,
    dataRepo,
    dataQueryService,
  });
  const celEvaluator = new CelEvaluator();

  return {
    findWorkflowById: (id) => workflowRepo.findById(id),
    findWorkflowByName: (name) => workflowRepo.findByName(name),
    findAllWorkflows: () => workflowRepo.findAll(),
    buildExpressionContext: (needsModelNamespace, sensitiveValues) =>
      needsModelNamespace
        ? modelResolver.buildContext(sensitiveValues)
        : Promise.resolve(modelResolver.buildLightContext(sensitiveValues)),
    evaluateCel: (expression, context) =>
      celEvaluator.evaluate(expression, context),
    evaluateCelAsync: (expression, context) =>
      celEvaluator.evaluateAsync(expression, context),
    saveEvaluatedWorkflow: (workflow, authoredExpressions, writtenReferences) =>
      evaluatedWorkflowRepo.save(
        workflow,
        authoredExpressions,
        undefined,
        writtenReferences,
      ),
    getEvaluatedPath: (id) => evaluatedWorkflowRepo.getPath(id),
  };
}

/**
 * Evaluates a single workflow, replacing CEL expressions with values.
 * Vault expressions are left as-is for runtime resolution.
 * forEach-related expressions (self.* and forEach.in) are left raw for
 * runtime expansion.
 */
async function evaluateWorkflowInternal(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  workflow: Workflow,
  inputs: Record<string, unknown>,
): Promise<WorkflowEvaluateItemData> {
  const workflowData = workflow.toData();
  const expressions = extractExpressions(workflowData, "", isAssertExprPath);
  // Persisted with the cache so `workflow run --last-evaluated` can vouch
  // for the source's expressions even after the source has been edited.
  const authoredExpressions = collectWorkflowAuthoredExpressions(workflow);

  if (expressions.length === 0 && Object.keys(inputs).length === 0) {
    // No expressions and no inputs - still save for consistency
    await deps.saveEvaluatedWorkflow(workflow, authoredExpressions);
    return {
      id: workflow.id,
      name: workflow.name,
      hadExpressions: false,
      outputPath: deps.getEvaluatedPath(workflow.id),
    };
  }

  // Coerce string CLI inputs to schema types (matching run.ts behavior)
  const coercedInputs = coerceInputTypes(inputs, workflow.inputs);

  // Build expression context with inputs
  const sensitiveValues = new RunSensitiveValues();
  const context = await deps.buildExpressionContext(
    requiresModelNamespace(workflowData),
    sensitiveValues,
  );
  context.inputs = coercedInputs;

  // Collect forEach.in expressions to skip during evaluation
  const forEachInExpressions = new Set<string>();
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (step.forEach && containsExpression(step.forEach.in)) {
        forEachInExpressions.add(step.forEach.in);
      }
    }
  }

  // Task targets deferred to step time, by the same rule as the run path.
  // Recorded by path so substitution below cannot write an identical
  // expression's value, evaluated elsewhere, into a deferred target.
  const isDeferredTaskTarget = createTaskTargetDeferral(workflow);
  const deferredTargetPaths = new Set<string>();

  // Evaluate CEL-only expressions; skip vault, self.*, and forEach.in expressions
  const evaluatedValues = new Map<string, unknown>();
  for (const expr of expressions) {
    if (containsRuntimeExpression(expr.celExpression)) {
      continue;
    }
    // Skip self.* expressions — they reference forEach variables resolved at runtime
    if (maskLiteralCalls(expr.celExpression).match(/\bself\??\./)) {
      continue;
    }
    // Skip steps.* expressions — the namespace only exists once a run does
    if (hasStepsNamespaceReference(expr.celExpression)) {
      continue;
    }
    // Skip forEach.in expressions — they must remain as strings for forEach expansion
    if (forEachInExpressions.has(expr.raw)) {
      continue;
    }
    // Skip guard expressions — they are evaluated at step execution time
    if (isGuardPath(expr.path)) {
      continue;
    }
    // Skip task.inputs/globalArgs/message expressions that depend on step outputs (resource, file, execution, data, file.contents).
    // These are evaluated at step execution time when upstream step outputs are available.
    if (
      (isTaskInputsPath(expr.path) || isTaskGlobalArgsPath(expr.path) ||
        isAssertMessagePath(expr.path)) &&
      hasStepOutputDependency(expr.celExpression)
    ) {
      continue;
    }
    // Skip task targets that read step output or sit on a guarded step
    if (isDeferredTaskTarget(expr)) {
      deferredTargetPaths.add(expr.path);
      continue;
    }

    try {
      const value = deps.evaluateCel(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    } catch (error) {
      // Skip expressions that fail to evaluate (might depend on runtime context)
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        `Warning: Could not evaluate expression "${expr.raw}": ${message}`,
      );
    }
  }

  // Replace only CEL-only expressions with evaluated values
  const evaluatedData = replaceExpressions(
    workflowData,
    evaluatedValues,
    (path) => isAssertExprPath(path) || deferredTargetPaths.has(path),
  );

  // Create new Workflow from evaluated data
  const evaluatedWorkflow = Workflow.fromData(evaluatedData as WorkflowData);

  // Expand forEach steps
  const expandedWorkflowData = evaluatedWorkflow.toData();
  for (const jobData of expandedWorkflowData.jobs) {
    const expandedSteps: typeof jobData.steps = [];

    for (const stepData of jobData.steps) {
      if (!stepData.forEach) {
        expandedSteps.push(stepData);
        continue;
      }

      // Evaluate the forEach.in expression
      const inSpan = scanExpressions(stepData.forEach.in)[0];
      if (!inSpan) {
        expandedSteps.push(stepData);
        continue;
      }

      // Async so data.* helpers that return Promises (latest, findByTag,
      // findBySpec, query, etc.) resolve before we iterate. cel-js
      // propagates Promises through its evaluator natively.
      if (!authoredExpressions.has(inSpan.raw)) {
        throw new UserError("forEach.in must be an authored expression");
      }
      const items = await deps.evaluateCelAsync(inSpan.inner, context);
      const itemName = stepData.forEach.item;
      const nameHasExpression = containsExpression(stepData.name);

      // Build one expanded step for a single forEach item: resolve every
      // available expression (self.* etc.) across the step name, task, AND
      // placement fields in one pass via the shared resolver, then apply the
      // unique-name suffix policy.
      const buildExpandedStep = (
        stepContext: Record<string, unknown>,
        fallbackSuffix: string,
        index: number,
      ) => {
        const resolved = resolveAvailableExpressions(
          {
            name: stepData.name,
            task: stepData.task,
            target: stepData.target,
            labels: stepData.labels,
            platform: stepData.platform,
          },
          stepContext,
          deps.evaluateCel,
          authoredExpressions,
          isAssertExprPath,
        ) as {
          name: string;
          task: typeof stepData.task;
          target: typeof stepData.target;
          labels: typeof stepData.labels;
          platform: typeof stepData.platform;
        };

        let expandedName: string;
        if (nameHasExpression) {
          expandedName = resolved.name;
          // If any expression in the name could not be resolved, the raw name
          // would repeat across iterations — append a suffix to keep names
          // unique (matches ForEachExpansionService.resolveForEachStepName).
          if (containsExpression(expandedName)) {
            expandedName = `${expandedName}-${fallbackSuffix}`;
          }
        } else {
          expandedName = `${stepData.name}-${fallbackSuffix}`;
        }

        return {
          ...stepData,
          name: forEachNameWithoutSecrets(expandedName, index, sensitiveValues),
          task: resolved.task,
          target: resolved.target,
          labels: resolved.labels,
          platform: resolved.platform,
          forEach: undefined,
        };
      };

      if (Array.isArray(items)) {
        for (const [index, item] of items.entries()) {
          const stepContext = {
            ...context,
            self: { ...context.self, _index: index, [itemName]: item },
          };
          expandedSteps.push(
            buildExpandedStep(stepContext, String(item), index),
          );
        }
      } else if (items && typeof items === "object") {
        for (const [index, [key, value]] of Object.entries(items).entries()) {
          const objItem = { key, value };
          const stepContext = {
            ...context,
            self: { ...context.self, _index: index, [itemName]: objItem },
          };
          expandedSteps.push(buildExpandedStep(stepContext, key, index));
        }
      } else {
        // Not iterable — keep original step
        expandedSteps.push(stepData);
      }
    }

    jobData.steps = expandedSteps;
  }

  const forEachExpanded = expandedWorkflowData.jobs.some(
    (j) =>
      j.steps.length !==
        workflowData.jobs.find((wj) => wj.name === j.name)?.steps.length,
  );

  // Save the expanded workflow (forEach resolved, expressions evaluated)
  // so --last-evaluated can run without inputs or further expansion
  const workflowToSave = forEachExpanded
    ? Workflow.fromData(expandedWorkflowData as WorkflowData)
    : evaluatedWorkflow;
  // Sensitive values are written as the vault references they came from.
  const persisted = persistEvaluatedWorkflow(
    workflowToSave,
    workflow,
    undefined,
    [],
    sensitiveValues,
  );
  await deps.saveEvaluatedWorkflow(
    persisted.workflow,
    authoredExpressions,
    persisted.writtenReferences,
  );

  return {
    id: workflow.id,
    name: workflow.name,
    hadExpressions: evaluatedValues.size > 0 || forEachExpanded,
    forEachExpanded,
    outputPath: deps.getEvaluatedPath(workflow.id),
    // Shown with sensitive values masked; the cache holds references.
    jobs: sensitiveValues.masked(
      expandedWorkflowData.jobs,
    ) as typeof expandedWorkflowData.jobs,
  };
}

/** Evaluates all workflow definitions. */
async function* evaluateAll(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  inputs: Record<string, unknown>,
  include: (
    workflow: { name: string; tags: Record<string, string> },
  ) => boolean = () => true,
): AsyncIterable<WorkflowEvaluateEvent> {
  const allWorkflows = (await deps.findAllWorkflows()).filter((workflow) =>
    include({ name: workflow.name, tags: workflow.tags ?? {} })
  );
  const items: WorkflowEvaluateItemData[] = [];

  for (const workflow of allWorkflows) {
    const result = await evaluateWorkflowInternal(
      ctx,
      deps,
      workflow,
      inputs,
    );
    items.push(result);
  }

  yield {
    kind: "completed",
    data: {
      items,
      total: allWorkflows.length,
      evaluated: items.filter((i) => i.hadExpressions).length,
    },
  };
}

/** Evaluates a single workflow definition. */
async function* evaluateSingle(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  workflowIdOrName: string,
  inputs: Record<string, unknown>,
  byId: boolean,
  expectedName?: string,
): AsyncIterable<WorkflowEvaluateEvent> {
  const lookupRepo = {
    findByName: deps.findWorkflowByName,
    findById: deps.findWorkflowById,
  };
  const workflow = byId
    ? await findWorkflowById(lookupRepo, workflowIdOrName, expectedName)
    : await findWorkflowByIdOrName(lookupRepo, workflowIdOrName);

  if (!workflow) {
    yield { kind: "error", error: notFound("Workflow", workflowIdOrName) };
    return;
  }

  const item = await evaluateWorkflowInternal(ctx, deps, workflow, inputs);

  yield { kind: "completed", data: item };
}

/** Evaluates workflow definitions, replacing CEL expressions with values. */
export async function* workflowEvaluate(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  input: WorkflowEvaluateInput,
): AsyncIterable<WorkflowEvaluateEvent> {
  yield { kind: "evaluating" };

  if (!input.workflowIdOrName) {
    yield* evaluateAll(ctx, deps, input.inputs, input.include);
  } else {
    yield* evaluateSingle(
      ctx,
      deps,
      input.workflowIdOrName,
      input.inputs,
      input.byId ?? false,
      input.expectedName,
    );
  }
}
