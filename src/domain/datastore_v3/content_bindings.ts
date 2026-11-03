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
 * a put must declare the identity its intent and key name, or a caller allowed
 * to write one aggregate could install content another is found by. Refusals
 * name the field, never its value, which may be a host path
 */

import { canonicalJson } from "../expressions/expression_references.ts";
import {
  isServeDrivenRun,
  type StepRunData,
  type WorkflowRunData,
} from "../workflows/workflow_run.ts";
import type { Intent } from "./intent.ts";
import { StepStart, type StepStartData } from "../workflows/step_start.ts";

export interface DeclaredIdentity {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

export interface KeyFacts {
  readonly fileId?: string;
  readonly fileName?: string;
  readonly type?: string;
}

/**
 * stored is the record the put replaces (for a move or rename, the record it
 * moves): an edit never changes a definition's id
 */
export function identityRefusal(
  intent: Intent,
  key: KeyFacts,
  declared: DeclaredIdentity,
  stored?: DeclaredIdentity,
): string | undefined {
  const id = declared.id.toLowerCase();
  if (key.type !== undefined && declared.type !== key.type) {
    return "its declared type is not the type its key names";
  }
  if (key.fileId !== undefined && id !== key.fileId) {
    return "its declared id is not the id its file is named by";
  }
  if (key.fileName !== undefined && declared.name !== key.fileName) {
    return "its declared name is not the name its file is named by";
  }
  if (stored !== undefined && id !== stored.id.toLowerCase()) {
    return "its declared id is not the id of the definition it replaces";
  }
  if (stored?.type !== undefined && declared.type !== stored.type) {
    return "its declared type is not the type of the definition it replaces";
  }
  switch (intent.kind) {
    case "definition.create":
    case "definition.edit":
    case "definition.rename-to":
    case "evaluated-workflow.save":
      return declared.name === intent.definition.name
        ? undefined
        : "its declared name is not the name its intent names";
    case "auto-definition.save":
      return id === intent.autoDefinition.id
        ? undefined
        : "its declared id is not the id its intent names";
    case "evaluated-definition.save":
      if (id !== intent.model.id) {
        return "its declared id is not the behavior its intent names";
      }
      return declared.type === intent.model.type
        ? undefined
        : "its declared type is not the behavior type its intent names";
  }
  return "it is not a definition";
}

export interface DeclaredRun {
  readonly workflowId: string;
  readonly runId?: string;
}

export function runIdentityRefusal(
  intent: Intent,
  declared: DeclaredRun,
): string | undefined {
  if (!("run" in intent)) return "it is not a run's record";
  if (declared.workflowId.toLowerCase() !== intent.run.workflowId) {
    return "its declared workflow is not the workflow its intent names";
  }
  if (
    declared.runId !== undefined &&
    declared.runId.toLowerCase() !== intent.run.runId
  ) {
    return "its declared run is not the run its intent names";
  }
  return undefined;
}

export function canonicalRunLogFile(workflowId: string, runId: string): string {
  return `.swamp/workflow-runs/${workflowId}/workflow-run-${runId}.log`;
}

/**
 * serve reads and appends to the path a record holds, so it must be the run's
 * own log, spelled as a record written on any platform spells it
 */
export function isCanonicalRunLogFile(
  logFile: string,
  workflowId: string,
  runId: string,
): boolean {
  return logFile.replaceAll("\\", "/") ===
    canonicalRunLogFile(workflowId, runId);
}

export interface AddedStepOutput {
  readonly jobName: string;
  readonly stepName: string;
  readonly output: unknown;
  readonly dataArtifacts: readonly unknown[];
}

export interface HeldChildRun {
  readonly decisions: readonly unknown[];
}

export interface RunRecordJudgement {
  readonly refusal?: string;
  readonly inputsChanged: boolean;
  readonly addedDeferred: readonly unknown[];
  readonly addedInherited: readonly string[];
  readonly addedReferences: readonly unknown[];
  readonly addedOutputs: readonly AddedStepOutput[];
}

export interface RunRecordContext {
  readonly workflowId: string;
  readonly runId: string;
  readonly before?: WorkflowRunData;
  readonly after: WorkflowRunData;
  readonly workflowVaults?: readonly string[];
  readonly heldChild?: (
    jobName: string,
    step: StepRunData,
  ) => HeldChildRun | undefined;
  readonly storedStepIsNested?: (
    jobName: string,
    step: StepRunData,
  ) => boolean;
}

/**
 * serve does not stop a member forging the record of a run they drive, only
 * that forgery reaching anything outside their run; statuses, outputs and
 * timings they report are out of scope
 */
export function judgeRunRecord(context: RunRecordContext): RunRecordJudgement {
  const { before, after } = context;
  const refuse = (refusal: string): RunRecordJudgement => ({
    refusal,
    inputsChanged: false,
    addedDeferred: [],
    addedInherited: [],
    addedReferences: [],
    addedOutputs: [],
  });
  const identity = runIdentityRefusal(
    {
      kind: "run.update",
      run: { workflowId: context.workflowId, runId: context.runId },
    },
    { workflowId: after.workflowId, runId: after.id },
  );
  if (identity !== undefined) return refuse(identity);
  if (
    after.logFile !== undefined &&
    !isCanonicalRunLogFile(after.logFile, context.workflowId, context.runId)
  ) {
    return refuse("its log file is not the run's own log");
  }
  if (before !== undefined && isServeDrivenRun(before)) {
    return refuse(
      "serve drives this run, so it takes no forwarded record: resume it with --server",
    );
  }
  if (
    after.instanceId !== undefined && after.instanceId !== before?.instanceId
  ) {
    return refuse("it names a serve instance as the run's owner");
  }
  if (
    after.ownerBeforeResume?.instanceId !== undefined &&
    !same(after.ownerBeforeResume, before?.ownerBeforeResume)
  ) {
    return refuse("it names a serve instance as the run's owner");
  }
  if (before === undefined) {
    if (after.triggeringPrincipal !== undefined) {
      return refuse(
        "it records a triggering principal, which only serve records",
      );
    }
    if (
      after.allowedVaults !== undefined &&
      !after.allowedVaults.every((vault) =>
        context.workflowVaults?.includes(vault) === true
      )
    ) {
      return refuse("its allowed vaults widen the workflow's vaults list");
    }
  } else {
    const frozen: [string, unknown, unknown][] = [
      [
        "triggering principal",
        before.triggeringPrincipal,
        after.triggeringPrincipal,
      ],
      ["parent run", before.parentRun, after.parentRun],
      ["allowed vaults", before.allowedVaults, after.allowedVaults],
      ["initiator", before.initiatedBy, after.initiatedBy],
      ["plan", before.runPlan, after.runPlan],
      [
        "inherited expressions",
        before.inheritedExpressions,
        after.inheritedExpressions,
      ],
    ];
    for (const [field, was, is] of frozen) {
      if (!same(was, is)) return refuse(`it changes the run's ${field}`);
    }
  }

  const seen = new Set<string>();
  for (const job of after.jobs) {
    for (const step of job.steps) {
      const key = stepKey(job.jobName, step.stepName);
      if (seen.has(key)) return refuse("it holds a duplicate step");
      seen.add(key);
    }
  }
  const beforeSteps = new Map<string, StepRunData>();
  for (const job of before?.jobs ?? []) {
    for (const step of job.steps) {
      beforeSteps.set(stepKey(job.jobName, step.stepName), step);
    }
  }
  // a decided step stays: re-added in a later record, it would read as never
  // decided
  const afterSteps = new Set(
    after.jobs.flatMap((job) =>
      job.steps.map((step) => stepKey(job.jobName, step.stepName))
    ),
  );
  for (const [key, step] of beforeSteps) {
    if (!afterSteps.has(key) && step.approvalDecision !== undefined) {
      return refuse("it drops a step that holds an approval decision");
    }
  }
  const addedOutputs: AddedStepOutput[] = [];
  for (const job of after.jobs) {
    for (const step of job.steps) {
      const prior = beforeSteps.get(stepKey(job.jobName, step.stepName));
      const refusal = judgeStep(context, job.jobName, prior, step);
      if (refusal !== undefined) return refuse(refusal);
      if (
        !same(prior?.output, step.output) ||
        !same(prior?.dataArtifacts, step.dataArtifacts)
      ) {
        if (
          step.output !== undefined || (step.dataArtifacts?.length ?? 0) > 0
        ) {
          addedOutputs.push({
            jobName: job.jobName,
            stepName: step.stepName,
            output: step.output,
            dataArtifacts: step.dataArtifacts ?? [],
          });
        }
      }
    }
  }
  if (!same(before?.workflowDataArtifacts, after.workflowDataArtifacts)) {
    addedOutputs.push({
      jobName: "",
      stepName: "",
      output: undefined,
      dataArtifacts: after.workflowDataArtifacts ?? [],
    });
  }

  return {
    inputsChanged: !same(before?.inputs, after.inputs) ||
      !same(before?.inputsProvenance, after.inputsProvenance) ||
      !same(before?.persistedInputsProvenance, after.persistedInputsProvenance),
    addedDeferred: added(
      before?.deferredExpressions,
      after.deferredExpressions,
    ),
    addedInherited: before === undefined
      ? [...(after.inheritedExpressions ?? [])]
      : [],
    addedReferences: added(before?.writtenReferences, after.writtenReferences),
    addedOutputs,
  };
}

function judgeStep(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
): string | undefined {
  // A retry clears what a waiting step held; it never gives it a new child.
  if (
    prior?.status === "waiting_approval" && step.status === "pending" &&
    step.nestedRun !== undefined && !same(prior.nestedRun, step.nestedRun)
  ) {
    return "it changes a waiting step's child run";
  }
  // An approver decides on what a gate shows, and serve acts on its child link.
  if (prior?.status === "waiting_approval" && step.status !== "pending") {
    for (
      const [field, was, is] of [
        ["prompt", prior.approvalPrompt, step.approvalPrompt],
        ["timeout", prior.approvalTimeout, step.approvalTimeout],
        ["start", prior.startedAt, step.startedAt],
        ["nested run", prior.nestedRun, step.nestedRun],
      ] as const
    ) {
      if (!same(was, is)) {
        return `it changes a waiting approval gate's ${field}`;
      }
    }
  }
  return decisionRefusal(context, jobName, prior, step) ??
    signalRefusal(prior, step);
}

function decisionRefusal(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
): string | undefined {
  if (same(prior?.approvalDecision, step.approvalDecision)) return undefined;
  if (step.approvalDecision === undefined) {
    return step.status === "pending"
      ? undefined
      : "it clears an approval decision without re-opening the gate";
  }
  if (prior?.approvalDecision !== undefined) {
    return "it changes an approval decision";
  }
  // a child's decision belongs on the step that calls the child: on a gate it
  // would read as an approval of something its approver never saw
  const held = context.storedStepIsNested?.(jobName, step) === true
    ? context.heldChild?.(jobName, step)?.decisions ?? []
    : [];
  return held.some((decision) => same(decision, step.approvalDecision))
    ? undefined
    : "it records an approval decision serve does not hold";
}

/**
 * a run a member drives cannot wait for a signal: serve delivers one only to a
 * wait it registered, and a wait id on a record would reach serve's wait
 * records, which cancel and delete by id
 */
function signalRefusal(
  prior: StepRunData | undefined,
  step: StepRunData,
): string | undefined {
  if (step.wait !== undefined && !same(prior?.wait, step.wait)) {
    return "a run a member drives cannot wait for a signal: run it with --server";
  }
  const signalOutput =
    (step.output as { type?: unknown } | undefined)?.type === "wait_for_signal";
  return signalOutput && !same(prior?.output, step.output)
    ? "it sets a signal's outcome serve does not hold"
    : undefined;
}

function stepKey(jobName: string, stepName: string): string {
  return JSON.stringify([jobName, stepName]);
}

function added<T>(
  before: readonly T[] | undefined,
  after: readonly T[] | undefined,
): T[] {
  const held = new Set((before ?? []).map((entry) => canonical(entry)));
  return (after ?? []).filter((entry) => !held.has(canonical(entry)));
}

function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return canonicalJson(value) ?? "undefined";
}

export interface RunStartContext {
  readonly workflowId: string;
  readonly runId: string;
  readonly fileName: string;
  readonly content: unknown;
  readonly record: WorkflowRunData | undefined;
}

/**
 * a start is a member's own report of a step it began: it may only make that
 * step of that member-driven run read as unknown on recovery, so it carries
 * nothing else, names its own key, and is refused for a run serve drives or a
 * run with no record
 */
export function judgeRunStart(context: RunStartContext): string | undefined {
  let start: StepStart;
  try {
    start = StepStart.create(context.content as StepStartData);
  } catch {
    return "its content is not a step start";
  }
  if (
    !sameId(start.workflowId, context.workflowId) ||
    !sameId(start.runId, context.runId)
  ) {
    return "it names another run";
  }
  if (start.fileName !== context.fileName) {
    return "its key is not the start it holds";
  }
  if (context.record === undefined) {
    return "its run has no record";
  }
  if (isServeDrivenRun(context.record)) {
    return "serve drives this run, so it takes no forwarded record: resume it with --server";
  }
  return undefined;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
