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
  canonicalJson,
} from "../expressions/expression_references.ts";
import { scanExpressions } from "../expressions/expression_scanner.ts";
import type { Workflow } from "./workflow.ts";

/**
 * One thing a workflow step runs. `location` is the step it sits in
 * (`jobs[j].steps[k]`), absent for a target not tied to a step.
 */
export type StepTarget =
  & { readonly location?: string }
  & (
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
    }
  );

/** Every step target in `workflow`, one per step that runs something. */
export function workflowStepTargets(workflow: Workflow): StepTarget[] {
  const targets: StepTarget[] = [];
  workflow.jobs.forEach((job, j) =>
    job.steps.forEach((step, k) => {
      const location = `jobs[${j}].steps[${k}]`;
      const task = step.task.data;
      if (task.type === "model_method") {
        if (task.modelIdOrName) {
          targets.push({
            kind: "model",
            modelIdOrName: task.modelIdOrName,
            methodName: task.methodName,
            location,
          });
        } else if (task.modelType && task.modelName) {
          targets.push({
            kind: "direct",
            modelType: task.modelType,
            modelName: task.modelName,
            methodName: task.methodName,
            location,
          });
        }
      } else if (task.type === "workflow") {
        targets.push({
          kind: "workflow",
          workflowIdOrName: task.workflowIdOrName,
          location,
        });
      }
    })
  );
  return targets;
}

/**
 * Every expression a run of `workflow` evaluates as authored: its `${{ }}`
 * templates and its assert steps' bare predicates.
 */
export function analyzeWorkflowExpressions(
  workflow: Workflow,
): AnalyzedExpression[] {
  const asserts: { raw: string; celExpression: string; path: string }[] = [];
  workflow.jobs.forEach((job, j) =>
    job.steps.forEach((step, k) => {
      const task = step.task.data;
      if (task.type === "assert") {
        asserts.push({
          raw: task.expr,
          celExpression: task.expr,
          path: `jobs[${j}].steps[${k}].task.expr`,
        });
      }
    })
  );
  return analyzeContentExpressions(workflow.toData(), asserts);
}

/**
 * Whether an edit changes what a computed step target can resolve to: the
 * workflow's inputs (their defaults feed `inputs.*`) or any step's `forEach`
 * (its items feed `self.*`), expression text included. Other edits, such as
 * a retag, cannot retarget a stored computed step, so they leave it alone.
 */
export function stepRetargetSourcesChanged(
  before: Workflow,
  after: Workflow,
): boolean {
  return canonicalJson(retargetSources(before)) !==
    canonicalJson(retargetSources(after));
}

function retargetSources(workflow: Workflow): unknown {
  const data = workflow.toData() as {
    inputs?: unknown;
    jobs?: { steps?: { forEach?: unknown }[] }[];
  };
  return {
    inputs: data.inputs ?? null,
    forEach: (data.jobs ?? []).map((job) =>
      (job.steps ?? []).map((step) => step.forEach ?? null)
    ),
  };
}

/**
 * A stable key for comparing targets across two versions of a workflow. A
 * computed target that reads `self` or `inputs` resolves per step (its
 * forEach), so its key includes the step; any other target is the same
 * wherever it sits.
 */
export function stepTargetKey(target: StepTarget): string {
  const { location, ...rest } = target;
  return isComputedStepTarget(target) && readsSelfOrInputs(target)
    ? JSON.stringify({ ...rest, location })
    : JSON.stringify(rest);
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
