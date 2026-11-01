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
 * What a forwarded put's content may declare and change, judged without
 * policy (swamp-club#3922).
 *
 * Serve finds aggregates by what their content declares: a definition by
 * its id or name, a vault by its name, a run by the ids it holds. A put is
 * authorised on its intent, so its content must declare the identity its
 * intent and key name, or a caller allowed to write one aggregate could
 * install content another is found by. A run record also carries what
 * serve acts on when it resumes or settles the run: who triggered it, where
 * it logs, which gates were decided. These rules say which of those fields
 * a forwarded record may set. A record reports what a run did: it may apply
 * a decision serve holds, and never makes one (swamp-club#4245).
 *
 * Every function is pure. Refusals name the field, never its value: the
 * value is the caller's, and may be a host path.
 *
 * @module
 */

import { canonicalJson } from "../expressions/expression_references.ts";
import {
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "../workflows/approval_timeout.ts";
import type { Step } from "../workflows/step.ts";
import { parseStoredWait } from "../workflows/signal_wait.ts";
import type { WaitOutcome } from "../workflows/signal_wait_records.ts";
import {
  StepRun,
  type StepRunData,
  type WorkflowRunData,
} from "../workflows/workflow_run.ts";
import type { Intent } from "./intent.ts";

/** The identity a definition-like file's content declares. */
export interface DeclaredIdentity {
  readonly id: string;
  readonly name: string;
  /** The behavior or vault type it declares, as normalised; none for a workflow. */
  readonly type?: string;
}

/** What a key's layout says about the file it names. */
export interface KeyFacts {
  /** The id a uuid-named file is named by. */
  readonly fileId?: string;
  /** The name a file whose intent carries only an id is named by. */
  readonly fileName?: string;
  /** The type the key's directory names, as normalised. */
  readonly type?: string;
}

/**
 * Why a definition, vault, auto-definition or evaluated file's declared
 * identity is not the one its intent and key name, or undefined when it is.
 * `stored` is the identity of the record the put replaces (for a move or a
 * rename, the record it moves): an edit never changes a definition's id.
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

/** The ids a run record or run snapshot declares. */
export interface DeclaredRun {
  readonly workflowId: string;
  readonly runId?: string;
}

/**
 * Why a run record's or run snapshot's declared run is not the one its
 * intent names, or undefined when it is.
 */
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

/**
 * The run log path a run record may hold: the one the run repository
 * stores, relative to the repository, with forward slashes.
 */
export function canonicalRunLogFile(workflowId: string, runId: string): string {
  return `.swamp/workflow-runs/${workflowId}/workflow-run-${runId}.log`;
}

/**
 * Whether `logFile` names the run's own log, as a record written on any
 * platform spells it: serve reads and appends to the path a record holds.
 */
export function isCanonicalRunLogFile(
  logFile: string,
  workflowId: string,
  runId: string,
): boolean {
  return logFile.replaceAll("\\", "/") ===
    canonicalRunLogFile(workflowId, runId);
}

/** What a step of the stored workflow is. */
export type StepKind = "approval" | "signal" | "nested" | "other" | "unknown";

/** A step output reference a run record adds, for serve to authorise. */
export interface AddedStepOutput {
  readonly jobName: string;
  readonly stepName: string;
  readonly output: unknown;
  readonly dataArtifacts: readonly unknown[];
}

/** What serve holds of the child run a nested step links to. */
export interface HeldChildRun {
  /** The child's status in serve's stored record. */
  readonly status: WorkflowRunData["status"];
  /** The approval decisions the child's steps hold. */
  readonly decisions: readonly unknown[];
}

/** What a forwarded run record needs serve to authorise beyond `run`. */
export interface RunRecordJudgement {
  /** Set when the record may not land whatever the caller holds. */
  readonly refusal?: string;
  /** Whether the record's inputs changed (or were set, on a create). */
  readonly inputsChanged: boolean;
  /** Deferred expressions the record adds, as stored. */
  readonly addedDeferred: readonly unknown[];
  /** Inherited expressions the record adds. */
  readonly addedInherited: readonly string[];
  /** Vault references the record adds, as stored. */
  readonly addedReferences: readonly unknown[];
  /** Completed steps whose output or data artifacts the record sets. */
  readonly addedOutputs: readonly AddedStepOutput[];
}

/** The inputs to {@link judgeRunRecord}. */
export interface RunRecordContext {
  readonly workflowId: string;
  readonly runId: string;
  /** The stored record the put replaces, absent for a run's first record. */
  readonly before?: WorkflowRunData;
  readonly after: WorkflowRunData;
  /** What each step of the stored workflow is, by job and step name. */
  readonly stepKind: (jobName: string, step: StepRunData) => StepKind;
  /** The stored workflow's steps of a job, for a gate's timeout. */
  readonly definitionSteps: (
    jobName: string,
  ) => ReadonlyArray<Step> | undefined;
  /** The workflow's `vaults:` list, undefined when it has none. */
  readonly workflowVaults?: readonly string[];
  /** Whether an instance id names a serve instance. */
  readonly isServeInstance: (instanceId: string) => boolean;
  /**
   * The stored record of the child a step links to, when that child links
   * back to this step; a link either record holds alone proves nothing.
   */
  readonly heldChild?: (
    jobName: string,
    step: StepRunData,
  ) => HeldChildRun | undefined;
  /**
   * Whether the stored workflow gives a step something that can skip it: its
   * own guard or dependencies, or its job's dependencies.
   */
  readonly maySkip?: (jobName: string, step: StepRunData) => boolean;
  /** The outcome serve holds for a signal wait, by wait id. */
  readonly heldOutcome?: (waitId: string) => WaitOutcome | undefined;
  readonly now: Date;
}

const TERMINAL = new Set(["succeeded", "failed", "skipped"]);
const WAITING_SIGNAL = new Set(["waiting", "waiting_signal"]);

/**
 * Judges a forwarded run record against the record it replaces and what serve
 * holds (swamp-club#3922, swamp-club#4245). A record reports what a run did,
 * and only serve's handlers decide. So:
 * 1. who triggered the run, its parent, vaults, initiator, plan, log and a
 *    serve owner, and a waiting gate's prompt, timeout, start and child link,
 *    are frozen;
 * 2. (the run snapshot, see `checkRunSnapshot`, is frozen too;)
 * 3. a decision equals one serve holds, and is cleared only by re-opening;
 * 4. a status moves toward stopping on `run` alone, and toward progress only
 *    to the outcome a held decision, deadline, signal outcome or child gives;
 * 5. a job or run succeeds only when no step waits or stands denied;
 * 6. step keys are unique;
 * 7. inputs, deferred expressions, vault references and step outputs it adds
 *    are returned for serve to authorise against the caller, under the lock.
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
  if (
    after.instanceId !== undefined &&
    context.isServeInstance(after.instanceId) &&
    after.instanceId !== before?.instanceId
  ) {
    return refuse("it names a serve instance as the run's owner");
  }
  if (
    after.ownerBeforeResume?.instanceId !== undefined &&
    context.isServeInstance(after.ownerBeforeResume.instanceId) &&
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
    if (before.triggeringPrincipal !== undefined) {
      // A run serve started is owned by a serve instance: cancel routing,
      // supersede and the orphaned-run reaper act on its owner.
      frozen.push(
        ["process", before.pid, after.pid],
        ["instance", before.instanceId, after.instanceId],
        ["prior owner", before.ownerBeforeResume, after.ownerBeforeResume],
      );
    }
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
  // A waiting step stays in the record until it settles: dropping or
  // renaming it would end the wait without judging how. A decided step
  // stays too: re-added in a later record, it would read as never decided.
  const afterSteps = new Set(
    after.jobs.flatMap((job) =>
      job.steps.map((step) => stepKey(job.jobName, step.stepName))
    ),
  );
  for (const [key, step] of beforeSteps) {
    if (afterSteps.has(key)) continue;
    if (
      step.status === "waiting_approval" || WAITING_SIGNAL.has(step.status)
    ) {
      return refuse("it drops a step that is waiting");
    }
    if (step.approvalDecision !== undefined) {
      return refuse("it drops a step that holds an approval decision");
    }
  }
  const addedOutputs: AddedStepOutput[] = [];
  for (const job of after.jobs) {
    for (const step of job.steps) {
      const prior = beforeSteps.get(stepKey(job.jobName, step.stepName));
      const kind = context.stepKind(job.jobName, step);
      const refusal = judgeStep(
        context,
        job.jobName,
        prior,
        step,
        kind,
        after.status,
        before?.status,
      );
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
  const status = statusRefusal(after);
  if (status !== undefined) return refuse(status);
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

/** Why the record's job or run status does not follow its steps, or undefined. */
function statusRefusal(after: WorkflowRunData): string | undefined {
  // A run reopens what an abort settled before it goes on, so a step that
  // stands settled by one holds its job back as a failure does.
  const holdsBack = (step: StepRunData) =>
    step.status === "waiting_approval" || WAITING_SIGNAL.has(step.status) ||
    (step.status === "failed" && step.allowedFailure !== true) ||
    step.settledByAbort === true;
  for (const job of after.jobs) {
    if (job.status === "succeeded" && job.steps.some(holdsBack)) {
      return "it marks a job succeeded over a step that waits or stands denied";
    }
  }
  if (
    after.status === "succeeded" &&
    after.jobs.some((job) => job.steps.some(holdsBack))
  ) {
    return "it marks the run succeeded over a step that waits or stands denied";
  }
  return undefined;
}

/** The refusal for one step's change, or undefined. */
function judgeStep(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
  kind: StepKind,
  runStatus: WorkflowRunData["status"],
  priorRunStatus: WorkflowRunData["status"] | undefined,
): string | undefined {
  // An approval gate never waits on a child run: a link would let a later
  // record settle it as a nested call's wait.
  if (
    kind === "approval" && step.status === "waiting_approval" &&
    step.nestedRun !== undefined
  ) {
    return "it gives an approval gate a child run";
  }
  if (prior?.status === "waiting_approval") {
    for (
      const [field, was, is] of [
        ["prompt", prior.approvalPrompt, step.approvalPrompt],
        ["timeout", prior.approvalTimeout, step.approvalTimeout],
        ["start", prior.startedAt, step.startedAt],
        // A waiting gate gains no child run: that would make it read as a
        // nested call's wait, which ends without a decision.
        ["nested run", prior.nestedRun, step.nestedRun],
      ] as const
    ) {
      // Re-opening clears what the gate asked; it asks again when it waits.
      if (!same(was, is) && step.status !== "pending") {
        return `it changes a waiting approval gate's ${field}`;
      }
    }
  }
  const decision = decisionRefusal(
    context,
    jobName,
    prior,
    step,
    priorRunStatus,
  );
  if (decision !== undefined) return decision;
  // Allowing a failure is the stored step's to say: a record setting it would
  // carry its job past the failure.
  if (
    step.status === "failed" && step.allowedFailure === true &&
    prior?.allowedFailure !== true
  ) {
    const defined = context.definitionSteps(jobName)?.find((s) =>
      s.name === (step.forEachTemplate ?? step.stepName)
    );
    if (defined?.allowFailure !== true) {
      return "it allows a failure the stored step does not";
    }
  }
  const settledByCancel = step.status === "failed" &&
    step.settledByAbort === true &&
    (runStatus === "cancelled" || runStatus === "failed");
  // A step that waited on an approval is a gate whatever the stored workflow
  // says it is now: an edit can retype the step while the run waits. One
  // that holds a decision is a gate whatever it is or links to. One the
  // stored workflow no longer names is a gate when it holds a gate's prompt.
  const nestedWait = prior?.nestedRun !== undefined;
  const gate = kind === "approval" ||
    (!nestedWait && prior?.status === "waiting_approval") ||
    prior?.approvalDecision !== undefined ||
    step.approvalDecision !== undefined ||
    (kind === "unknown" && !nestedWait &&
      (prior?.approvalPrompt !== undefined ||
        step.approvalPrompt !== undefined));
  // A workflow step succeeds only as its stored child did, however it got
  // here: leaving the wait first, or holding a decision, changes nothing.
  if (
    (kind === "nested" || nestedWait || step.nestedRun !== undefined) &&
    step.status === "succeeded" && prior?.status !== "succeeded" &&
    context.heldChild?.(jobName, step)?.status !== "succeeded"
  ) {
    return "it succeeds a nested step before its child did";
  }
  const signal = kind === "signal" ||
    (prior !== undefined && WAITING_SIGNAL.has(prior.status));
  // A step that waited on a signal ends by the signal rules whatever the
  // stored workflow says it is now: retyped to a gate, it could otherwise
  // leave the wait for a gate's.
  if (prior !== undefined && WAITING_SIGNAL.has(prior.status)) {
    return signalRefusal(context, jobName, prior, step, settledByCancel);
  }
  if (gate) {
    return gateRefusal(
      context,
      jobName,
      prior,
      step,
      settledByCancel,
      runStatus,
    );
  }
  if (signal) {
    return signalRefusal(context, jobName, prior, step, settledByCancel);
  }
  // A nested wait leaves only for an outcome, or by a retry. A forEach that
  // shrinks skips the iterations it no longer names.
  if (nestedWait && prior?.status === "waiting_approval") {
    if (step.status === "skipped" && step.forEachTemplate === undefined) {
      return "it skips a nested step that is waiting on its child";
    }
    if (
      (step.status === "pending" && step.resetByResume !== true) ||
      step.status === "running" || step.status === "unknown"
    ) {
      return "it moves a nested step out of its wait without an outcome";
    }
  }
  return undefined;
}

/** Check 3: a decision is one serve holds; only re-opening clears it. */
function decisionRefusal(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
  priorRunStatus: WorkflowRunData["status"] | undefined,
): string | undefined {
  if (same(prior?.approvalDecision, step.approvalDecision)) return undefined;
  if (step.approvalDecision === undefined) {
    // A retry takes up a run that ended; one still going has nothing to retry.
    return step.status === "pending" && step.resetByResume === true &&
        (priorRunStatus === "failed" || priorRunStatus === "cancelled")
      ? undefined
      : "it clears an approval decision without re-opening the gate";
  }
  if (prior?.approvalDecision !== undefined) {
    return "it changes an approval decision";
  }
  // A child's decision only ever fails its parent: an approval there says
  // nothing of the child's other gates.
  const held = step.status === "failed"
    ? context.heldChild?.(jobName, step)?.decisions ?? []
    : [];
  return held.some((decision) => same(decision, step.approvalDecision))
    ? undefined
    : "it records an approval decision serve does not hold";
}

/** Check 4 for a gate: the outcome of a decision, a deadline or a stop. */
function gateRefusal(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
  settledByCancel: boolean,
  runStatus: WorkflowRunData["status"],
): string | undefined {
  const waited = prior?.status === "waiting_approval";
  const decided = prior?.approvalDecision !== undefined;
  if (
    prior?.status === "pending" && prior.resetByResume === true &&
    step.status === "pending" && step.resetByResume !== true
  ) {
    return "it clears the mark of a re-opened gate";
  }
  if (step.status === "pending" && prior?.status === "running") {
    return "it moves a running gate back to pending";
  }
  if (step.status === "pending") {
    // Re-opening makes the gate wait for a fresh decision, and the mark keeps
    // it from being skipped past the decision the record just dropped.
    return prior !== undefined && prior.status !== "pending" &&
        (waited || decided) && step.resetByResume !== true
      ? "it re-opens a gate without a retry"
      : undefined;
  }
  if (prior !== undefined && prior.status === step.status) return undefined;
  if (step.status === "waiting_approval") return undefined;
  if (step.status === "skipped") {
    // An abort settles what it never started; otherwise the stored workflow
    // must give the gate something that can skip it. A record's guard result
    // cannot be checked, so a guarded gate stays the run's own to report.
    const stopped = step.settledByAbort === true &&
      (runStatus === "cancelled" || runStatus === "failed");
    return !waited && !decided && step.approvalDecision === undefined &&
        (prior === undefined || prior.status === "pending") &&
        prior?.resetByResume !== true &&
        (stopped || context.maySkip?.(jobName, step) === true)
      ? undefined
      : "it skips a gate that waited, was decided or was re-opened";
  }
  if (!TERMINAL.has(step.status)) {
    // Unsettling a gate that waited or was decided re-opens it unjudged.
    return waited || decided
      ? "it moves a gate out of its wait or decision without an outcome"
      : undefined;
  }
  if (settledByCancel) return undefined;
  if (decided && TERMINAL.has(prior!.status)) {
    return "it changes the status of a decided gate";
  }
  const decision = step.approvalDecision;
  if (
    decision !== undefined &&
    step.status === (decision.approved ? "succeeded" : "failed")
  ) {
    return undefined;
  }
  if (
    decision === undefined && step.status === "failed" && prior !== undefined &&
    timeoutPassed(context, jobName, prior)
  ) {
    return undefined;
  }
  return "it completes a gate without a decision serve holds";
}

/** Check 4 for a signal wait: a stored outcome, a deadline or a stop. */
function signalRefusal(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
  settledByCancel: boolean,
): string | undefined {
  const waited = prior !== undefined && WAITING_SIGNAL.has(prior.status);
  if (WAITING_SIGNAL.has(step.status)) {
    return waited &&
        (!same(prior.output, step.output) || !same(prior.wait, step.wait))
      ? "it changes a waiting signal step's wait or output"
      : undefined;
  }
  if (settledByCancel) return undefined;
  if (step.status === "succeeded") {
    if (prior?.status === "succeeded" && same(prior.output, step.output)) {
      return undefined;
    }
    return appliesHeldOutcome(context, prior, step)
      ? undefined
      : "it sets a signal's outcome serve does not hold";
  }
  if (step.status === "skipped") {
    return !waited && context.maySkip?.(jobName, step) === true
      ? undefined
      : "it skips a signal wait the stored step gives nothing to skip";
  }
  if (!waited) return undefined;
  if (step.status === "failed") {
    const stored = parseStoredWait(prior.wait);
    if (stored?.kind !== "valid") return undefined;
    if (stored.wait.deadline.getTime() < context.now.getTime()) {
      return undefined;
    }
    const outcome = context.heldOutcome?.(stored.wait.id);
    return outcome !== undefined && outcome.kind !== "accepted"
      ? undefined
      : "it fails a signal wait before its deadline without a stored outcome";
  }
  return step.status === "pending" && step.resetByResume === true
    ? undefined
    : "it ends a signal wait without a stored outcome";
}

/**
 * Whether `step` is what applying the outcome serve holds for its wait gives,
 * worked out by the same code a run applies it with.
 */
function appliesHeldOutcome(
  context: RunRecordContext,
  prior: StepRunData | undefined,
  step: StepRunData,
): boolean {
  const raw =
    (prior !== undefined && WAITING_SIGNAL.has(prior.status)
      ? prior.wait
      : step.wait) as Record<string, unknown> | undefined;
  const stored = parseStoredWait(raw);
  if (stored?.kind !== "valid") return false;
  const outcome = context.heldOutcome?.(stored.wait.id);
  if (outcome?.kind !== "accepted") return false;
  const { receipt: _receipt, ...open } = raw!;
  const applied = StepRun.fromData({
    stepName: step.stepName,
    status: "waiting_signal",
    wait: open,
  });
  if (!applied.applyWaitOutcome(outcome)) return false;
  const data = applied.toData();
  return same(data.output, step.output) && same(data.wait, step.wait);
}

/** Whether a waiting gate's deadline has passed by `context.now`. */
function timeoutPassed(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData,
): boolean {
  const started = prior.startedAt === undefined
    ? undefined
    : new Date(prior.startedAt);
  const timeout = evaluateApprovalTimeout(
    started,
    gateTimeoutSeconds(prior, context.definitionSteps(jobName)),
    context.now,
  );
  return timeout?.expired === true;
}

function stepKey(jobName: string, stepName: string): string {
  return JSON.stringify([jobName, stepName]);
}

/** The entries of `after` that `before` does not hold, compared as JSON. */
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
