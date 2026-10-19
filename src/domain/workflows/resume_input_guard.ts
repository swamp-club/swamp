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
 * Whether a resume's `--input` may change the run's inputs (swamp-club#3583).
 *
 * A step that has run, and that the resume will not run again, used the
 * inputs it read as they were. A gate checked them, an approval showed them,
 * a nested workflow forwarded them. Changing one of those inputs on resume
 * would let the steps after it act on a value nothing before them saw, so the
 * resume is refused. An input that only steps still to run read can be
 * supplied or replaced: the placeholder-then-resume pattern (swamp-club#467).
 */

import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
import { inputNamesRead } from "../expressions/cel_grammar.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import type { Job } from "./job.ts";
import {
  evaluated,
  planFailedRunResume,
  suspendedWayOut,
} from "./resume_reset.ts";
import type { ResumeReset } from "./resume_reset.ts";
import type { Step } from "./step.ts";
import type { Workflow } from "./workflow.ts";
import { computeWorkflowFingerprint } from "./workflow_fingerprint.ts";
import type { JobRun, StepRun, WorkflowRun } from "./workflow_run.ts";

/** The inputs one step's expressions read. */
interface StepReads {
  readonly names: ReadonlySet<string>;
  /** It reads `inputs` whole, by a computed key, or in text that does not parse. */
  readonly opaque: boolean;
}

/**
 * The stored data of the behavior definition a step names, or undefined when
 * there is none. A definition is evaluated with the run's inputs in scope, so
 * `${{ inputs.X }}` in it reads the workflow's X.
 */
export type DefinitionData = (
  modelIdOrName: string,
) => Promise<unknown | undefined>;

const READS_EVERYTHING: StepReads = { names: new Set(), opaque: true };
const READS_NOTHING: StepReads = { names: new Set(), opaque: false };

/**
 * Refuses a resume whose inputs change a value a finished step read. Throws
 * a UserError coded `resume_input_consumed` before anything changes; returns
 * when every changed input is read only by steps still to run.
 *
 * `reset` is the failed-run reset the resume will apply, undefined for a
 * suspended run: a step it resets runs again with the new value.
 */
export async function checkResumeInputOverrides(
  workflow: Workflow,
  run: WorkflowRun,
  resumeInputs: Record<string, unknown>,
  reset: ResumeReset | undefined,
  definitionData: DefinitionData,
): Promise<void> {
  const changed = changedKeys(run.inputs, resumeInputs);
  if (changed.length === 0) return;

  const definitions = new Map<string, Promise<StepReads>>();
  const definitionReads = (name: string, missing: StepReads) => {
    const cacheKey = `${missing.opaque}\0${name}`;
    let reads = definitions.get(cacheKey);
    if (!reads) {
      reads = readsOfDefinition(definitionData, name, missing);
      definitions.set(cacheKey, reads);
    }
    return reads;
  };
  // Edited since the run started, or replaying the evaluated cache, whose
  // source may predate the workflow on disk: what its finished steps read
  // can no longer be told from the workflow on disk.
  const recorded = run.runPlan?.definitionFingerprint;
  const workflowReads = run.replayedEvaluatedCache ||
      (recorded !== undefined &&
        recorded !== await computeWorkflowFingerprint(workflow))
    ? READS_EVERYTHING
    : readsOfExpressions(workflowExpressions(workflow));
  const readersByKey = new Map<string, string[]>();
  for (const jobRun of run.jobs) {
    for (const stepRun of jobRun.steps) {
      if (!ranAndStays(stepRun, reset)) continue;
      const reads = union([
        workflowReads,
        ...await readsOf(workflow, jobRun, stepRun, definitionReads),
      ]);
      for (const key of changed) {
        if (!reads.opaque && !reads.names.has(key)) continue;
        const readers = readersByKey.get(key) ?? [];
        if (!readers.includes(stepRun.stepName)) readers.push(stepRun.stepName);
        readersByKey.set(key, readers);
      }
    }
  }
  if (readersByKey.size === 0) return;
  throw new UserError(
    refusalMessage(workflow, run, readersByKey),
    "resume_input_consumed",
  );
}

/**
 * The supplied top-level keys whose value, merged over the stored inputs,
 * differs from the stored one. A key the run did not have counts as changed:
 * a step may have read its absence (`has(inputs.x)`, `inputs.?x`).
 */
function changedKeys(
  stored: Readonly<Record<string, unknown>>,
  resumeInputs: Record<string, unknown>,
): string[] {
  const merged = deepMerge({ ...stored }, resumeInputs);
  return Object.keys(resumeInputs).filter((key) =>
    !Object.hasOwn(stored, key) ||
    canonicalJson(merged[key]) !== canonicalJson(stored[key])
  );
}

/**
 * Whether a stored step read its inputs and keeps that result on this resume.
 * A pending step has not run; a reset one runs again; one the run's abort
 * settled without starting is reopened. A step skipped for its dependency or
 * its job never evaluated anything; a guarded skip evaluated its guard.
 */
function ranAndStays(
  stepRun: StepRun,
  reset: ResumeReset | undefined,
): boolean {
  if (stepRun.status === "pending") return false;
  if (reset?.steps.has(stepRun.stepName)) return false;
  if (stepRun.settledByAbort) return false;
  const skip = stepRun.skipReason?.kind;
  return skip !== "dependency" && skip !== "job_skipped";
}

/**
 * What a stored step read, one entry per source: its job's own fields (a job
 * name can read an input), its authored step, and the definition the step
 * runs. A job or step whose name is an expression is stored evaluated, so a
 * record matching no authored name is read against every candidate written
 * with an expression. A record with no candidate at all (the workflow was
 * edited since) reads everything: what it read can no longer be told.
 */
async function readsOf(
  workflow: Workflow,
  jobRun: JobRun,
  stepRun: StepRun,
  definitionReads: (name: string, missing: StepReads) => Promise<StepReads>,
): Promise<StepReads[]> {
  const named = workflow.jobs.find((job) => job.name === jobRun.jobName);
  const jobs = named ? [named] : workflow.jobs.filter((j) => evaluated(j.name));
  const template = stepRun.forEachTemplate ?? stepRun.stepName;
  const found: StepReads[] = [];
  let matched = false;
  for (const job of jobs) {
    found.push(readsOfExpressions(jobExpressions(job)));
    const step = job.steps.find((s) => s.name === template);
    const steps = step ? [step] : job.steps.filter((s) => evaluated(s.name));
    for (const s of steps) {
      matched = true;
      found.push(readsOfExpressions(stepExpressions(s)));
      const task = s.task.data;
      if (task.type !== "model_method") continue;
      if (task.modelIdOrName) {
        found.push(await definitionReads(task.modelIdOrName, READS_EVERYTHING));
      } else if (task.modelType && task.modelName) {
        // Direct execution adopts an existing definition of that name and
        // keeps its method arguments; with none, the definition is created
        // from the step's own arguments, read above.
        found.push(
          evaluated(task.modelType)
            ? READS_EVERYTHING
            : await definitionReads(task.modelName, READS_NOTHING),
        );
      }
    }
  }
  if (!matched) found.push(READS_EVERYTHING);
  return found;
}

/**
 * What a definition reads. One named by an expression, or failing to load,
 * reads everything: what the step ran cannot be told. `missing` is what a
 * step that names no existing definition read.
 */
async function readsOfDefinition(
  definitionData: DefinitionData,
  name: string,
  missing: StepReads,
): Promise<StepReads> {
  if (evaluated(name)) return READS_EVERYTHING;
  let data: unknown;
  try {
    data = await definitionData(name);
  } catch {
    return READS_EVERYTHING;
  }
  if (data === undefined) return missing;
  return readsOfExpressions(
    extractExpressions(data).map((e) => e.celExpression),
  );
}

function readsOfExpressions(expressions: readonly string[]): StepReads {
  const names = new Set<string>();
  let opaque = false;
  for (const cel of expressions) {
    const reads = inputNamesRead(cel);
    for (const name of reads.names) names.add(name);
    opaque ||= reads.opaque;
  }
  return { names, opaque };
}

function union(all: readonly StepReads[]): StepReads {
  return {
    names: new Set(all.flatMap((r) => [...r.names])),
    opaque: all.some((r) => r.opaque),
  };
}

/**
 * The workflow's own fields, which every step inherits: placement, tags. Not
 * its jobs, read per record; its inputs schema, which declares rather than
 * reads; or its trigger, which supplies inputs.
 */
function workflowExpressions(workflow: Workflow): string[] {
  const { jobs: _jobs, inputs: _inputs, trigger: _trigger, ...ownFields } =
    workflow.toData();
  return extractExpressions(ownFields).map((e) => e.celExpression);
}

function jobExpressions(job: Job): string[] {
  const { steps: _steps, ...ownFields } = job.toData();
  return extractExpressions(ownFields).map((e) => e.celExpression);
}

/** Every `${{ }}` in the step, and an assert's bare CEL `expr`. */
function stepExpressions(step: Step): string[] {
  const found = extractExpressions(step.toData()).map((e) => e.celExpression);
  const task = step.task.data;
  if (task.type === "assert") found.push(task.expr);
  return found;
}

/**
 * Names each refused input and the steps that read it, never a value: inputs
 * may hold secrets. A failed run can retry from a step, which runs it and
 * every step after it again; a suspended run cannot.
 */
function refusalMessage(
  workflow: Workflow,
  run: WorkflowRun,
  readersByKey: ReadonlyMap<string, readonly string[]>,
): string {
  const quoted = (names: readonly string[]) =>
    names.map((n) => `"${n}"`).join(", ");
  // Keys the same steps read are named together, to stay within serve's
  // error limit.
  const keysByReaders = new Map<
    string,
    { readers: readonly string[]; keys: string[] }
  >();
  for (const [key, readers] of readersByKey) {
    const group = keysByReaders.get(quoted(readers)) ?? { readers, keys: [] };
    group.keys.push(key);
    keysByReaders.set(quoted(readers), group);
  }
  const parts = [...keysByReaders.values()].map(({ readers, keys }) =>
    `${keys.length === 1 ? "input" : "inputs"} ${quoted(keys)} ${
      keys.length === 1 ? "was" : "were"
    } already used by ${readers.length === 1 ? "step" : "steps"} ${
      quoted(readers)
    }`
  );
  // A key the run has no value for cannot be compared: a run replaying a
  // cache written before its evaluation inputs were recorded keeps none.
  const unrecorded = [...readersByKey.keys()].filter((key) =>
    !Object.hasOwn(run.inputs, key)
  );
  const noValue = unrecorded.length === 0
    ? ""
    : unrecorded.length < readersByKey.size
    ? ` The run recorded no value for ${quoted(unrecorded)} to compare with.`
    : readersByKey.size === 1
    ? " The run recorded no value for it to compare with."
    : " The run recorded none of them to compare with.";
  const keys = [...readersByKey.keys()];
  // Each word quoted for pasting: a `<value>` placeholder is a redirect
  // unquoted, and a forEach template carries `${{ }}`.
  const inputArgs = keys.map((k) => `--input ${quoteShellWord(`${k}=<value>`)}`)
    .join(" ");
  const name = quoteShellWord(workflow.name);
  const newRun =
    `a new run with all its inputs (swamp workflow run ${name} ${inputArgs})`;
  const from = run.status === "failed"
    ? retryStepResetting(workflow, run, readersByKey)
    : undefined;
  const wayOut = from !== undefined
    ? `Retry from "${from}" (swamp workflow resume ${name} --run ${run.id} --from ${
      quoteShellWord(from)
    } ${inputArgs}), or start ${newRun}.`
    : run.status === "suspended"
    // Left suspended, the run would wait for a resume that cannot come. A
    // run serve started is cancelled through serve.
    ? `${suspendedWayOut(workflow, run)} Then start ${newRun}.`
    : `Start ${newRun}.`;
  // The run id first: serve cuts an error at 512 characters.
  return `Run ${run.id} is unchanged: resume cannot change an input a step already ran with. ${
    capitalize(parts.join("; "))
  }.${noValue} ${wayOut}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The first reader, as `--from` names it (a forEach iteration by its
 * template), when retrying from it resets every step that read a refused
 * input. Undefined when no single reader's retry does: readers in parallel
 * branches, or a step `--from` cannot name.
 *
 * The first reader is taken in record order, which across jobs may not be
 * the earliest in dependency order. The hint then falls back to a new run:
 * less helpful, never wrong.
 */
function retryStepResetting(
  workflow: Workflow,
  run: WorkflowRun,
  readersByKey: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  const readers = new Set([...readersByKey.values()].flat());
  const first = run.jobs.flatMap((j) => j.steps)
    .find((s) => readers.has(s.stepName));
  if (!first) return undefined;
  const template = first.forEachTemplate ?? first.stepName;
  try {
    const reset = planFailedRunResume(workflow, run, template);
    return [...readers].every((r) => reset.steps.has(r)) ? template : undefined;
  } catch {
    return undefined;
  }
}
