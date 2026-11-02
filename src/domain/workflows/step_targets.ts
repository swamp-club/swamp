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
 * serve authorizes the targets an edit adds against the writer, since a run
 * invokes them under only the workflow's own run grant
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

export type StepTarget =
  & { readonly location?: string }
  & (
    | {
      readonly kind: "model";
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

/**
 * scopes by name stay put when other steps are added, removed or reordered, so
 * an edit elsewhere does not look like it moved them
 */
function stepScopes(workflow: Workflow): Map<string, string> {
  const scopes = new Map<string, string>();
  const jobsSeen = new Map<string, number>();
  workflow.jobs.forEach((job, j) => {
    const jobN = jobsSeen.get(job.name) ?? 0;
    jobsSeen.set(job.name, jobN + 1);
    const stepsSeen = new Map<string, number>();
    job.steps.forEach((step, k) => {
      const stepN = stepsSeen.get(step.name) ?? 0;
      stepsSeen.set(step.name, stepN + 1);
      scopes.set(
        `jobs[${j}].steps[${k}]`,
        `jobs[${JSON.stringify([job.name, jobN])}].steps[${
          JSON.stringify([step.name, stepN])
        }]`,
      );
    });
  });
  return scopes;
}

function scopedPath(scopes: Map<string, string>, path: string): string {
  const match = /^jobs\[\d+\]\.steps\[\d+\]/.exec(path);
  if (!match) return path;
  const scope = scopes.get(match[0]);
  return scope ? scope + path.slice(match[0].length) : path;
}

export function workflowStepTargets(workflow: Workflow): StepTarget[] {
  const targets: StepTarget[] = [];
  const scopes = stepScopes(workflow);
  workflow.jobs.forEach((job, j) =>
    job.steps.forEach((step, k) => {
      const location = scopes.get(`jobs[${j}].steps[${k}]`)!;
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
 * a renamed step or one moved to another job has a new scope and counts as
 * changed; removed steps are not returned
 */
export function changedStepTargets(
  before: Workflow,
  after: Workflow,
): StepTarget[] {
  const stored = stepContents(before);
  const changed = new Set<string>();
  for (const [scope, content] of stepContents(after)) {
    if (stored.get(scope) !== content) changed.add(scope);
  }
  return workflowStepTargets(after).filter((target) =>
    target.location !== undefined && changed.has(target.location)
  );
}

function stepContents(workflow: Workflow): Map<string, string> {
  const scopes = stepScopes(workflow);
  const contents = new Map<string, string>();
  workflow.jobs.forEach((job, j) =>
    job.steps.forEach((step, k) =>
      contents.set(
        scopes.get(`jobs[${j}].steps[${k}]`)!,
        canonicalJson(step.toData()),
      )
    )
  );
  return contents;
}

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
  const scopes = stepScopes(workflow);
  return analyzeContentExpressions(workflow.toData(), asserts).map((e) => ({
    ...e,
    paths: e.paths.map((path) => scopedPath(scopes, path)),
  }));
}

/**
 * only workflow inputs (defaults feed inputs.*) or a step's forEach (items feed
 * self.*) can retarget a stored computed step; other edits such as a retag
 * leave it alone
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
 * a computed target reading self or inputs resolves per step, so its key
 * includes the step; any other target is the same wherever it sits
 */
export function stepTargetKey(target: StepTarget): string {
  const { location, ...rest } = target;
  return isComputedStepTarget(target) && readsSelfOrInputs(target)
    ? JSON.stringify({ ...rest, location })
    : JSON.stringify(rest);
}

export function isComputedStepTarget(target: StepTarget): boolean {
  return stepTargetNames(target).some(containsExpression);
}

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
