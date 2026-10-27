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
 * under its evaluated name (`site-west`), so it cannot be found by name. A
 * name whose expressions only read the run's inputs is evaluated against the
 * inputs the run stored. Otherwise the job is paired by position: evaluation
 * keeps every job and their order, so the run stores job `i` of the workflow
 * as its job `i` while the workflow's jobs still line up with the run's
 * (swamp-club#3815).
 */

import {
  replaceExpressionSpans,
  scanExpressions,
} from "../expressions/expression_scanner.ts";
import type { Job } from "./job.ts";
import type { Workflow } from "./workflow.ts";
import type { JobRun, WorkflowRun } from "./workflow_run.ts";

const INPUT_REFERENCE = /^inputs((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/;

/**
 * A name written with an expression is stored evaluated, so it cannot be
 * compared with a stored record before the workflow is evaluated.
 */
export function evaluatedName(name: string): boolean {
  return name.includes("${{");
}

/**
 * Whether `stored` could be what the expression-named `template` became: it
 * holds the literal text around the expressions, in order. A linear scan,
 * so a long name cannot make it backtrack.
 */
function fits(template: string, stored: string): boolean {
  const parts: string[] = [];
  let from = 0;
  for (const span of scanExpressions(template)) {
    parts.push(template.slice(from, span.start));
    from = span.end;
  }
  parts.push(template.slice(from));
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!stored.startsWith(first)) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = stored.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return stored.length - last.length >= at && stored.endsWith(last);
}

/**
 * The name `template` evaluates to when each of its expressions only reads
 * a scalar of the run's stored `inputs`, else undefined.
 */
function nameFromInputs(
  template: string,
  inputs: Readonly<Record<string, unknown>>,
): string | undefined {
  let resolved = true;
  const name = replaceExpressionSpans(template, (span) => {
    const path = span.inner.match(INPUT_REFERENCE)?.[1];
    let value: unknown = path === undefined ? undefined : inputs;
    for (const key of path?.slice(1).split(".") ?? []) {
      value = typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
    }
    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return String(value);
    }
    resolved = false;
    return "";
  });
  return resolved ? name : undefined;
}

/**
 * Pairs each expression-named workflow job with the name of the stored job
 * it evaluated to, keyed by the job's name in the workflow. A job whose name
 * evaluates, from the run's inputs, to a stored job's name is paired with
 * that job wherever it now stands. Any other is paired by position, which
 * needs the workflow's jobs to line up with the run's: the same number,
 * every literal job at its stored position, and each stored name fitting the
 * literal text around the expressions. Returns undefined when a job cannot
 * be paired, or when two would share a stored job. An empty map means the
 * workflow has no expression-named job.
 */
export function pairExpressionJobs(
  workflow: Workflow,
  run: WorkflowRun,
): Map<string, string> | undefined {
  const pairs = new Map<string, string>();
  const literal = new Set(
    workflow.jobs.filter((j) => !evaluatedName(j.name)).map((j) => j.name),
  );
  const unpaired: number[] = [];
  for (const [i, job] of workflow.jobs.entries()) {
    if (!evaluatedName(job.name)) continue;
    const name = nameFromInputs(job.name, run.inputs);
    if (name !== undefined && !literal.has(name) && run.getJob(name)) {
      pairs.set(job.name, name);
    } else {
      unpaired.push(i);
    }
  }
  if (unpaired.length > 0) {
    if (workflow.jobs.length !== run.jobs.length) return undefined;
    for (const [i, job] of workflow.jobs.entries()) {
      if (!evaluatedName(job.name) && run.jobs[i].jobName !== job.name) {
        return undefined;
      }
    }
    for (const i of unpaired) {
      const job = workflow.jobs[i];
      const stored = run.jobs[i].jobName;
      if (literal.has(stored) || !fits(job.name, stored)) return undefined;
      pairs.set(job.name, stored);
    }
  }
  if (new Set(pairs.values()).size !== pairs.size) return undefined;
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
