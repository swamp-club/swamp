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
  type ApprovalDecisionData,
  isServeDrivenRun,
  type JobRunData,
  type StepRunData,
  type WorkflowRunData,
} from "../workflows/workflow_run.ts";
import { laneFailed, laneRecords } from "../workflows/fan_out_lanes.ts";
import {
  fanOutGatePromptLine,
  fanOutGates,
  gateApproved,
} from "../workflows/fan_out_gates.ts";
import type { FanOutGateKind } from "../remote/fan_out.ts";
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
  readonly decisions: readonly ApprovalDecisionData[];
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
 * a new run names the principal serve stamps on its commit, or a child its
 * parent's initiator, so a resumed child keeps who began the run; a serve with
 * no authenticated caller checks nothing
 */
export function runInitiatorRefusal(input: {
  readonly initiatedBy: string | undefined;
  readonly caller: string | undefined;
  readonly parent?: { readonly initiatedBy?: string };
}): string | undefined {
  if (input.caller === undefined) return undefined;
  const expected = input.parent !== undefined
    ? input.parent.initiatedBy
    : input.caller;
  if (input.initiatedBy === expected) return undefined;
  return `its initiator is ${
    input.initiatedBy === undefined ? "missing" : `"${input.initiatedBy}"`
  }, not ${
    input.parent !== undefined
      ? `its parent run's ${expected ?? "(none)"}`
      : expected
  }: it was written by a swamp CLI older than this serve; upgrade your swamp CLI and run the work again`;
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
    if (after.client !== undefined) {
      return refuse("it records a client, which only serve records");
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
      ["client", before.client, after.client],
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

  const fanOut = fanOutPlanRefusal(before, after) ??
    fanOutHaltRefusal(before, after) ?? fanOutGateRefusal(before, after);
  if (fanOut !== undefined) return refuse(fanOut);

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

/**
 * an older CLI strips a client it does not know when it rewrites a record, so a
 * missing client still matches; the audit event keeps the value
 */
function sameDecision(
  held: ApprovalDecisionData | undefined,
  forwarded: ApprovalDecisionData | undefined,
): boolean {
  if (same(held, forwarded)) return true;
  if (held === undefined) return false;
  const { client: _client, ...withoutClient } = held;
  return same(withoutClient, forwarded);
}

function decisionRefusal(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
): string | undefined {
  if (sameDecision(prior?.approvalDecision, step.approvalDecision)) {
    return undefined;
  }
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
  return held.some((decision) => sameDecision(decision, step.approvalDecision))
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

/**
 * a plan and its snapshot are written once, together, while the job's steps
 * are all still pending, and never changed or dropped; lane records carry no
 * steps of their own
 */
function fanOutPlanRefusal(
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
): string | undefined {
  for (const job of after.jobs) {
    const plan = job.fanOutPlan;
    const prior = before?.jobs.find((candidate) =>
      candidate.jobName === job.jobName
    );
    if (prior?.fanOutPlan !== undefined) {
      if (!same(prior.fanOutPlan, plan)) {
        return `it changes the fan-out plan of job '${job.jobName}'`;
      }
      // a plan written without a snapshot keeps having none
      if (!same(prior.fanOutSnapshot, job.fanOutSnapshot)) {
        return `it changes the fan-out snapshot of job '${job.jobName}'`;
      }
      continue;
    }
    if (job.fanOutSnapshot !== undefined && plan === undefined) {
      return `it adds a fan-out snapshot to job '${job.jobName}' without a fan-out plan`;
    }
    if (plan === undefined) continue;
    if (prior === undefined) {
      return `it adds a fan-out plan to job '${job.jobName}', which the run's earlier record does not hold`;
    }
    if (prior.steps.some((step) => step.status !== "pending")) {
      return `it adds a fan-out plan to job '${job.jobName}' after its steps began`;
    }
    if (plan.lanes.some((lane) => lane.steps.length > 0)) {
      return `its fan-out plan for job '${job.jobName}' holds lane steps outside the job's steps`;
    }
  }
  for (const prior of before?.jobs ?? []) {
    if (prior.fanOutPlan === undefined) continue;
    if (!after.jobs.some((job) => job.jobName === prior.jobName)) {
      return `it drops job '${prior.jobName}', which holds a fan-out plan`;
    }
  }
  return undefined;
}

const ENDED_JOB_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
]);

/**
 * a halt is appended once, in the record where its job fails, and never changed
 * or dropped; resume orders lanes by it, so it must match the plan and lanes
 */
function fanOutHaltRefusal(
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
): string | undefined {
  for (const job of after.jobs) {
    const halts = job.fanOutHalts ?? [];
    const prior = before?.jobs.find((candidate) =>
      candidate.jobName === job.jobName
    );
    const priorHalts = prior?.fanOutHalts ?? [];
    if (
      halts.length < priorHalts.length ||
      !same(halts.slice(0, priorHalts.length), priorHalts)
    ) {
      return `it changes or drops a fan-out halt of job '${job.jobName}'`;
    }
    if (halts.length === priorHalts.length) continue;
    if (halts.length > priorHalts.length + 1) {
      return `it adds more than one fan-out halt to job '${job.jobName}'`;
    }
    if (
      prior === undefined || ENDED_JOB_STATUSES.has(prior.status) ||
      job.status !== "failed"
    ) {
      return `it adds a fan-out halt to job '${job.jobName}' other than in the record where the job fails`;
    }
    const mismatch = haltMismatch(job, halts[halts.length - 1]);
    if (mismatch !== undefined) {
      return `its fan-out halt of job '${job.jobName}' ${mismatch}`;
    }
  }
  return undefined;
}

const SETTLED_UNSTARTED: ReadonlySet<string> = new Set(["skipped", "failed"]);

// held or cancelled before it started: what a halt, rejection or cancel writes
function settledUnstarted(step: StepRunData): boolean {
  return step.settledByAbort === true && SETTLED_UNSTARTED.has(step.status);
}

function leftPending(
  prior: StepRunData | undefined,
  step: StepRunData,
): boolean {
  return prior?.status === "pending" && step.status !== "pending" &&
    !settledUnstarted(step);
}

/**
 * gates are written once, pending, with the plan, and never dropped; a gate
 * opens only where its plan puts it, with its fixed prompt line, and no lane
 * passes an undecided gate
 */
function fanOutGateRefusal(
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
): string | undefined {
  for (const job of after.jobs) {
    const prior = before?.jobs.find((candidate) =>
      candidate.jobName === job.jobName
    );
    const priorGates = prior !== undefined
      ? fanOutGates(prior)
      : new Map<FanOutGateKind, StepRunData>();
    const gates = fanOutGates(job);
    for (const [kind] of priorGates) {
      if (!gates.has(kind)) {
        return `it drops the ${kind} approval gate of job '${job.jobName}'`;
      }
    }
    const plan = job.fanOutPlan;
    if (plan === undefined || gates.size === 0) continue;
    for (const [kind, gate] of gates) {
      if (!priorGates.has(kind)) {
        if (prior?.fanOutPlan !== undefined) {
          return `it adds the ${kind} approval gate of job '${job.jobName}' after its plan`;
        }
        if (gate.status !== "pending") {
          return `it adds the ${kind} approval gate of job '${job.jobName}' already started`;
        }
      }
      if (plan.lanes.some((lane) => lane.worker === `approve-${kind}`)) {
        return `its ${kind} approval gate of job '${job.jobName}' is named as a lane of the plan`;
      }
    }
    if (gates.has("canary") && plan.batches.length < 2) {
      return `it gives job '${job.jobName}' a canary approval gate with no batch after the canary`;
    }

    const priorSteps = new Map(
      (prior?.steps ?? []).map((step) => [step.stepName, step]),
    );
    const records = laneRecords(job.steps, plan.lanes);
    const canary = new Set(plan.batches[0] ?? []);
    const laneSteps = [...records.values()].flat();
    for (const [kind, gate] of gates) {
      const was = priorSteps.get(gate.stepName);
      if (
        gate.status !== "waiting_approval" || was?.status === "waiting_approval"
      ) {
        continue;
      }
      if (gate.approvalPrompt !== fanOutGatePromptLine(job.jobName, kind)) {
        return `it opens the ${kind} approval gate of job '${job.jobName}' with a prompt swamp does not write`;
      }
      if (
        kind === "plan" && laneSteps.some((step) => step.status !== "pending")
      ) {
        return `it opens the plan approval gate of job '${job.jobName}' after a lane started`;
      }
      if (kind === "canary") {
        for (const [worker, steps] of records) {
          const open = steps.some((step) =>
            step.status === "pending" || step.status === "running" ||
            step.status === "unknown" || step.status.startsWith("waiting")
          );
          if (
            canary.has(worker)
              ? open
              : steps.some((s) => s.status !== "pending")
          ) {
            return `it opens the canary approval gate of job '${job.jobName}' ${
              canary.has(worker)
                ? "before the canary batch settled"
                : "after a later batch started"
            }`;
          }
        }
      }
    }
    const planGate = gates.get("plan");
    const canaryGate = gates.get("canary");
    for (const [worker, steps] of records) {
      for (const step of steps) {
        if (!leftPending(priorSteps.get(step.stepName), step)) continue;
        if (planGate !== undefined && !gateApproved(planGate)) {
          return `it starts lane '${worker}' of job '${job.jobName}' before its plan is approved`;
        }
        if (
          canaryGate !== undefined && !canary.has(worker) &&
          !gateApproved(canaryGate)
        ) {
          return `it starts lane '${worker}' of job '${job.jobName}' before its canary is approved`;
        }
      }
    }
  }
  return undefined;
}

function haltMismatch(
  job: JobRunData,
  halt: NonNullable<JobRunData["fanOutHalts"]>[number],
): string | undefined {
  const plan = job.fanOutPlan;
  if (plan === undefined) return "has no fan-out plan";
  if (plan.maxFailures === null || halt.maxFailures !== plan.maxFailures) {
    return "does not carry the plan's failure budget";
  }
  if (halt.failed.length <= halt.maxFailures) {
    return "names no more failed lanes than the budget allows";
  }
  if (halt.batch >= plan.batches.length) return "names a batch the plan lacks";
  const named = [...halt.failed, ...halt.held];
  if (new Set(named).size !== named.length) {
    return "names a lane more than once";
  }
  const records = laneRecords(job.steps, plan.lanes);
  for (const worker of named) {
    if (!records.has(worker)) {
      return `names '${worker}', not a lane of the plan`;
    }
  }
  // a resumed lane keeps the steps it finished before its failed one
  for (const worker of halt.held) {
    const steps = records.get(worker)!;
    if (
      !steps.some((step) => step.status === "skipped" && step.settledByAbort) ||
      steps.some((step) =>
        step.status !== "succeeded" && step.status !== "skipped" &&
        !(step.status === "failed" && step.allowedFailure)
      )
    ) {
      return `holds lane '${worker}', which started`;
    }
  }
  for (const worker of halt.failed) {
    const steps = records.get(worker)!.map((step) => ({
      status: step.status,
      allowedFailure: step.allowedFailure ?? false,
    }));
    if (!laneFailed(steps)) {
      return `names lane '${worker}' as failed, and it did not fail`;
    }
  }
  return undefined;
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
