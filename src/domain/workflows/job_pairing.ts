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
 * Which workflow job a stored job of a run belongs to.
 *
 * A job named with an expression (`site-${{ inputs.region }}`) is stored
 * under its evaluated name (`site-west`), so it cannot be found by name.
 * Evaluation keeps every job and their order, so the run stores job `i` of
 * the workflow as its job `i`; while the workflow's jobs still line up with
 * the run's, each expression-named job is paired with the stored job at its
 * position (swamp-club#3815).
 */

import type { Job } from "./job.ts";
import type { Workflow } from "./workflow.ts";
import type { JobRun, WorkflowRun } from "./workflow_run.ts";

const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/**
 * A name written with an expression is stored evaluated, so it cannot be
 * compared with a stored record before the workflow is evaluated.
 */
export function evaluatedName(name: string): boolean {
  return name.includes("${{");
}

/** Whether `stored` could be what the expression-named `template` became. */
function fits(template: string, stored: string): boolean {
  const literal = template.split(EXPRESSION)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${literal.join("[\\s\\S]*")}$`).test(stored);
}

/**
 * Pairs each expression-named workflow job with the name of the stored job
 * it evaluated to, keyed by the job's name in the workflow. Returns undefined
 * when the workflow's jobs no longer line up with the run's: a different
 * number of jobs, a literal job at another position, or a stored name that
 * does not fit the literal text around an expression-named job's
 * expressions. An empty map means the workflow has no expression-named job.
 */
export function pairExpressionJobs(
  workflow: Workflow,
  run: WorkflowRun,
): Map<string, string> | undefined {
  const pairs = new Map<string, string>();
  if (!workflow.jobs.some((j) => evaluatedName(j.name))) return pairs;
  if (workflow.jobs.length !== run.jobs.length) return undefined;
  const literal = new Set(
    workflow.jobs.filter((j) => !evaluatedName(j.name)).map((j) => j.name),
  );
  for (const [i, job] of workflow.jobs.entries()) {
    const stored = run.jobs[i].jobName;
    if (!evaluatedName(job.name)) {
      if (stored !== job.name) return undefined;
      continue;
    }
    if (literal.has(stored) || !fits(job.name, stored)) return undefined;
    pairs.set(job.name, stored);
  }
  return pairs;
}

/**
 * The workflow job the stored job `jobRun` belongs to: the literal job of
 * that name, else the expression-named job paired with it. Undefined when
 * no job is, or when `pairs` could not be made.
 */
export function workflowJobOf(
  workflow: Workflow,
  jobRun: JobRun,
  pairs: ReadonlyMap<string, string> | undefined,
): Job | undefined {
  const literal = workflow.jobs.find((j) =>
    !evaluatedName(j.name) && j.name === jobRun.jobName
  );
  if (literal) return literal;
  return workflow.jobs.find((j) =>
    evaluatedName(j.name) && pairs?.get(j.name) === jobRun.jobName
  );
}
