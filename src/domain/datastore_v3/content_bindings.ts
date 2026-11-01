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

/** A step output reference a run record adds, for serve to authorise. */
export interface AddedStepOutput {
  readonly jobName: string;
  readonly stepName: string;
  readonly output: unknown;
  readonly dataArtifacts: readonly unknown[];
}

/** The approval decisions a stored child run, linking back, holds. */
export interface HeldChildRun {
  readonly decisions: readonly unknown[];
}

/**
 * Whether serve drives a run: only serve records a triggering principal or
 * names an instance as a run's owner, so either marks the run whichever team
 * node holds it. Gates bind on such a run, and no member writes its record.
 */
export function isServeDrivenRun(
  run: { readonly triggeringPrincipal?: unknown; readonly instanceId?: string },
): boolean {
  return run.triggeringPrincipal !== undefined || run.instanceId !== undefined;
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
  /** The workflow's `vaults:` list, undefined when it has none. */
  readonly workflowVaults?: readonly string[];
  /**
   * The stored record of the child a step links to, when that child links
   * back to this step; a link either record holds alone proves nothing.
   */
  readonly heldChild?: (
    jobName: string,
    step: StepRunData,
  ) => HeldChildRun | undefined;
  /** The outcome serve holds for a signal wait, by wait id. */
  readonly heldOutcome?: (waitId: string) => WaitOutcome | undefined;
}

const WAITING_SIGNAL = new Set(["waiting", "waiting_signal"]);

/**
 * Judges a forwarded run record against the record it replaces and what serve
 * holds (swamp-club#3922, swamp-club#4245). Serve does not try to stop a member
 * forging the record of a run they drive; it stops that forgery reaching
 * anything outside their own run. The statuses, outputs and timings they report
 * are out of scope ("Run records: the threat model" in
 * `design/enablers/access-control.md`). So:
 * - a run serve drives takes no forwarded record at all;
 * - a decision equals one serve holds, and a step holding one stays;
 * - who triggered the run, its parent, vaults, initiator, plan, log and a serve
 *   owner, and what a waiting gate shows its approver, are frozen;
 * - step keys are unique, so a record has one reading;
 * - what it adds that serve acts on is returned for serve to authorise against
 *   the caller, under the lock.
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
    return refuse("serve drives this run, so it takes no forwarded record");
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
  // A decided step stays: re-added in a later record, it would read as never
  // decided.
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

/** The refusal for one step's change, or undefined. */
function judgeStep(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
): string | undefined {
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
    signalDecisionRefusal(context, prior, step);
}

/**
 * A decision is one serve holds. A record may carry the step's own, or on a
 * nested step one its linked child holds; only a retry clears one.
 */
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
  const held = context.heldChild?.(jobName, step)?.decisions ?? [];
  return held.some((decision) => same(decision, step.approvalDecision))
    ? undefined
    : "it records an approval decision serve does not hold";
}

/**
 * A signal's outcome is one serve holds: a record setting a receipt or a
 * signal's output must hold what applying that outcome gives, worked out by the
 * same code a run applies it with. A step's status is the run's to report, so
 * nothing here asks that a step reached `succeeded` through a signal.
 */
function signalDecisionRefusal(
  context: RunRecordContext,
  prior: StepRunData | undefined,
  step: StepRunData,
): string | undefined {
  const receiptOf = (s: StepRunData | undefined) =>
    (s?.wait as { receipt?: unknown } | undefined)?.receipt;
  const signalOutput =
    (step.output as { type?: unknown } | undefined)?.type === "wait_for_signal";
  const sets =
    !same(receiptOf(prior), receiptOf(step)) && receiptOf(step) !== undefined ||
    (signalOutput && !same(prior?.output, step.output));
  if (!sets) return undefined;
  const raw =
    (prior !== undefined && WAITING_SIGNAL.has(prior.status)
      ? prior.wait
      : step.wait) as Record<string, unknown> | undefined;
  const stored = parseStoredWait(raw);
  const outcome = stored?.kind === "valid"
    ? context.heldOutcome?.(stored.wait.id)
    : undefined;
  if (outcome?.kind !== "accepted") {
    return "it sets a signal's outcome serve does not hold";
  }
  const { receipt: _receipt, ...open } = raw!;
  const applied = StepRun.fromData({
    stepName: step.stepName,
    status: "waiting_signal",
    wait: open,
  });
  if (!applied.applyWaitOutcome(outcome)) {
    return "it sets a signal's outcome serve does not hold";
  }
  const data = applied.toData();
  return same(data.output, step.output) && same(data.wait, step.wait)
    ? undefined
    : "it sets a signal's outcome serve does not hold";
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
