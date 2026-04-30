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

import type { Definition } from "../definitions/definition.ts";
import type { Workflow, WorkflowInput } from "./workflow.ts";
import { Workflow as WorkflowClass } from "./workflow.ts";
import {
  extractExpressions,
  isTaskInputsPath,
  replaceExpressions,
} from "../expressions/expression_parser.ts";
import { containsRuntimeExpression } from "../expressions/expression_evaluation_service.ts";
import {
  extractDependencies,
  hasStepOutputDependency,
} from "../expressions/dependency_extractor.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";

/**
 * Minimal CEL evaluator surface needed by the workflow + definition
 * evaluators. The infrastructure-side CelEvaluator implements this
 * structurally; the indirection keeps these domain evaluators free of
 * a direct infrastructure import.
 */
export interface CelExpressionEvaluator {
  evaluateAsync(
    expression: string,
    context: Record<string, unknown>,
  ): Promise<unknown>;
}

/**
 * Evaluates CEL expressions in a workflow definition, leaving vault
 * expressions, runtime-only expressions, self.* references, forEach.in
 * expressions, and task.inputs with step-output dependencies raw. Those
 * are resolved at runtime when their inputs become available.
 *
 * **Strict** about per-expression evaluation errors: any throw during
 * `evaluateAsync` propagates out, surfacing the error to the caller.
 * This pairs intentionally with DefinitionExpressionEvaluator's lenient
 * behaviour — workflows declare their evaluation order explicitly, so
 * a thrown CEL error is a real bug.
 */
/**
 * Result of evaluating a workflow's CEL expressions.
 * `expressionsEvaluated` is exposed for callers that record it as a
 * tracing-span attribute.
 */
export interface WorkflowEvaluationResult {
  workflow: Workflow;
  expressionsEvaluated: number;
}

export class WorkflowExpressionEvaluator {
  constructor(private readonly celEvaluator: CelExpressionEvaluator) {}

  async evaluate(
    workflow: Workflow,
    context: ExpressionContext,
  ): Promise<WorkflowEvaluationResult> {
    const workflowData = workflow.toData();
    const expressions = extractExpressions(workflowData);

    if (expressions.length === 0) {
      return { workflow, expressionsEvaluated: 0 };
    }

    // Collect forEach.in expressions to skip during evaluation. They
    // remain as strings so forEach expansion can iterate them at run
    // time.
    const forEachInExpressions = new Set<string>();
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.forEach) {
          const match = step.forEach.in.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (match) {
            forEachInExpressions.add(step.forEach.in);
          }
        }
      }
    }

    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }
      // self.* references forEach variables resolved at runtime.
      if (expr.celExpression.match(/\bself\./)) {
        continue;
      }
      // forEach.in expressions must remain as strings for expansion.
      if (forEachInExpressions.has(expr.raw)) {
        continue;
      }
      // task.inputs that depend on step outputs are evaluated at step
      // execution time when upstream step outputs are available.
      if (
        isTaskInputsPath(expr.path) &&
        hasStepOutputDependency(expr.celExpression)
      ) {
        continue;
      }

      // Strict: per-expression eval errors propagate.
      const value = await this.celEvaluator.evaluateAsync(
        expr.celExpression,
        context,
      );
      evaluatedValues.set(expr.raw, value);
    }

    const evaluatedData = replaceExpressions(workflowData, evaluatedValues);
    return {
      workflow: WorkflowClass.fromData(evaluatedData as WorkflowInput),
      expressionsEvaluated: evaluatedValues.size,
    };
  }
}

/**
 * Evaluates CEL expressions in a definition, leaving vault expressions
 * and runtime-only expressions raw.
 *
 * **Lenient** about per-expression evaluation errors: catches them and
 * leaves the expression unresolved. This pairs intentionally with
 * WorkflowExpressionEvaluator's strict behaviour — definitions are
 * built up over time and may legitimately reference inputs that are
 * absent when CEL eval first runs. The Proxy on globalArgs surfaces a
 * clear error later if the method actually needs the unresolved value.
 *
 * Also skips expressions that reference model resource/file data not
 * yet available in the context (e.g., a referenced model was never
 * executed). Unlike inputs, model data is never conditionally accessed
 * in CEL — member access on a missing model ref is always an error.
 */
export class DefinitionExpressionEvaluator {
  constructor(private readonly celEvaluator: CelExpressionEvaluator) {}

  async evaluate(
    definition: Definition,
    context: ExpressionContext,
  ): Promise<Definition> {
    const definitionData = definition.toData();
    const expressions = extractExpressions(definitionData);

    if (expressions.length === 0) {
      return definition;
    }

    const evaluatedValues = new Map<string, unknown>();
    for (const expr of expressions) {
      if (containsRuntimeExpression(expr.celExpression)) {
        continue;
      }

      let hasMissingModelDep = false;
      const deps = extractDependencies(expr.celExpression);
      for (const dep of deps) {
        if (dep.type === "resource" || dep.type === "file") {
          const modelData = context.model[dep.modelRef];
          if (
            !modelData ||
            (dep.type === "resource" && !modelData.resource) ||
            (dep.type === "file" && !modelData.file)
          ) {
            hasMissingModelDep = true;
            break;
          }
        }
      }
      if (hasMissingModelDep) {
        continue;
      }

      try {
        const value = await this.celEvaluator.evaluateAsync(
          expr.celExpression,
          context,
        );
        evaluatedValues.set(expr.raw, value);
      } catch {
        // Lenient: leave unresolved. CEL threw because an input
        // referenced directly (not inside a conditional branch) is
        // absent from context. Surfaces later through the globalArgs
        // Proxy if actually needed.
      }
    }

    const evaluatedData = replaceExpressions(definitionData, evaluatedValues);
    // Dynamic import preserved from the previous inline implementation
    // — it dodges a circular initialization issue that older versions
    // of definition.ts had with the workflows module. Investigate
    // separately whether a top-level import is now safe.
    const { Definition: DefClass } = await import(
      "../definitions/definition.ts"
    );
    return DefClass.fromData(
      evaluatedData as ReturnType<typeof definition.toData>,
    );
  }
}
