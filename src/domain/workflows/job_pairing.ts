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
 * an expression-named job is stored under its evaluated name; one reading only
 * run inputs is evaluated against the stored inputs, otherwise paired by
 * position since evaluation keeps every job and their order
 */

import {
  replaceExpressionSpans,
  scanExpressions,
} from "../expressions/expression_scanner.ts";
import type { Job } from "./job.ts";
import type { Workflow } from "./workflow.ts";
import type { JobRun, WorkflowRun } from "./workflow_run.ts";

const INPUT_REFERENCE = /^inputs((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/;

export function evaluatedName(name: string): boolean {
  return name.includes("${{");
}

/**
 * whether stored could be what the expression-named template became: it holds
 * the literal text around the expressions, in order; a linear scan, so a long
 * name cannot backtrack
 */
function fits(template: string, stored: string): boolean {
  const parts: string[] = [];
  let from = 0;
  for (const span of scanExpressions(template)) {
    parts.push(template.slice(from, span.start));
    from = span.end;
  }
  parts.push(template.slice(from));
  // An unclosed `${{` is no expression: the name is literal text.
  if (parts.length === 1) return stored === template;
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
 * pairs by evaluating from stored inputs, else by position, which needs the
 * same job count, literal jobs at their stored positions and each stored name
 * fitting the literal text; undefined when unpairable
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

/**
 * resume finds each job's record by its evaluated name, so a reset-reached job
 * evaluating to another name than its paired stored job would reset one job and
 * walk another; pairs are the ones the reset was planned with
 */
export function evaluatedJobMismatch(
  workflow: Workflow,
  resolved: Workflow,
  run: WorkflowRun,
  resetJobs: ReadonlySet<string>,
  pairs: ReadonlyMap<string, string> | undefined,
): string | undefined {
  for (const [i, job] of workflow.jobs.entries()) {
    if (!evaluatedName(job.name)) continue;
    const now = resolved.jobs[i]?.name;
    const paired = pairs?.get(job.name);
    const held = paired !== undefined && resetJobs.has(paired);
    if (now !== undefined && run.getJob(now) && (!held || now === paired)) {
      continue;
    }
    return held
      ? `Job "${job.name}" now evaluates to "${now}", but the run stored it as "${paired}".`
      : `Job "${job.name}" now evaluates to "${now}", which is not in the run.`;
  }
  return undefined;
}
