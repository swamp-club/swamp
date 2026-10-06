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

/**
 * What a workflow's steps run: the models and nested workflows a run of it
 * will invoke. Serve authorizes the targets a workflow edit adds against the
 * writer, since a run of the workflow invokes them under only the workflow's
 * own `run` grant.
 */

import { containsExpression } from "../expressions/expression_parser.ts";
import {
  analyzeContentExpressions,
  type AnalyzedExpression,
  analyzeExpression,
} from "../expressions/expression_references.ts";
import { scanExpressions } from "../expressions/expression_scanner.ts";
import type { Workflow } from "./workflow.ts";

/** One thing a workflow step runs. */
export type StepTarget =
  | {
    readonly kind: "model";
    /** A model name or id, or text with an expression computing one. */
    readonly modelIdOrName: string;
    readonly methodName: string;
  }
  | {
    readonly kind: "direct";
    readonly modelType: string;
    readonly modelName: string;
    readonly methodName: string;
  }
  | {
    readonly kind: "workflow";
    readonly workflowIdOrName: string;
  };

/** Every step target in `workflow`, one per step that runs something. */
export function workflowStepTargets(workflow: Workflow): StepTarget[] {
  const targets: StepTarget[] = [];
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task.data;
      if (task.type === "model_method") {
        if (task.modelIdOrName) {
          targets.push({
            kind: "model",
            modelIdOrName: task.modelIdOrName,
            methodName: task.methodName,
          });
        } else if (task.modelType && task.modelName) {
          targets.push({
            kind: "direct",
            modelType: task.modelType,
            modelName: task.modelName,
            methodName: task.methodName,
          });
        }
      } else if (task.type === "workflow") {
        targets.push({
          kind: "workflow",
          workflowIdOrName: task.workflowIdOrName,
        });
      }
    }
  }
  return targets;
}

/**
 * Every expression a run of `workflow` evaluates as authored: its `${{ }}`
 * templates and its assert steps' bare predicates.
 */
export function analyzeWorkflowExpressions(
  workflow: Workflow,
): AnalyzedExpression[] {
  const asserts: { raw: string; celExpression: string }[] = [];
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const task = step.task.data;
      if (task.type === "assert") {
        asserts.push({ raw: task.expr, celExpression: task.expr });
      }
    }
  }
  return analyzeContentExpressions(workflow.toData(), asserts);
}

/** A stable key for comparing targets across two versions of a workflow. */
export function stepTargetKey(target: StepTarget): string {
  return JSON.stringify(target);
}

/** Whether any name in `target` is computed by an expression. */
export function isComputedStepTarget(target: StepTarget): boolean {
  return stepTargetNames(target).some(containsExpression);
}

/**
 * Whether a computed target reads `self` or `inputs`, so a plain value the
 * workflow holds (an input default) can retarget it.
 */
export function readsSelfOrInputs(target: StepTarget): boolean {
  return stepTargetNames(target).some((name) =>
    scanExpressions(name).some((span) =>
      analyzeExpression(span.inner).readsSelfOrInputs
    )
  );
}

function stepTargetNames(target: StepTarget): string[] {
  switch (target.kind) {
    case "model":
      return [target.modelIdOrName, target.methodName];
    case "direct":
      return [target.modelType, target.modelName, target.methodName];
    case "workflow":
      return [target.workflowIdOrName];
  }
}
