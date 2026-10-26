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
 * a forwarded record may set, and which changes need more than `run`.
 *
 * Every function is pure. Refusals name the field, never its value: the
 * value is the caller's, and may be a host path.
 *
 * @module
 */

import {
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "../workflows/approval_timeout.ts";
import type { Step } from "../workflows/step.ts";
import type {
  StepRunData,
  WorkflowRunData,
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
export type StepKind = "approval" | "signal" | "other" | "unknown";

/** A step output reference a run record adds, for serve to authorise. */
export interface AddedStepOutput {
  readonly jobName: string;
  readonly stepName: string;
  readonly output: unknown;
  readonly dataArtifacts: readonly unknown[];
}

/** What a forwarded run record needs beyond `run` on its workflow. */
export interface RunRecordJudgement {
  /** Set when the record may not land whatever the caller holds. */
  readonly refusal?: string;
  /** Actions on the workflow the record's transitions need. */
  readonly actions: ReadonlySet<"approve" | "signal">;
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
  readonly now: Date;
}

const TERMINAL = new Set(["succeeded", "failed", "skipped"]);
const WAITING_SIGNAL = new Set(["waiting", "waiting_signal"]);

/**
 * Judges a forwarded run record against the record it replaces
 * (swamp-club#3922). A local run writes its record as it goes, so most of
 * a record changes freely; what serve acts on does not:
 * - its log file is the run's own, and serve-started runs keep their owner;
 * - who triggered it, its parent and the vaults it may use are set by
 *   serve or by the run's first record, and frozen after;
 * - its plan and the expressions its parent passed in are frozen;
 * - deciding an approval gate needs `approve`, a signal's outcome `signal`,
 *   and a gate's prompt, timeout and start are frozen while it waits;
 * - inputs, deferred expressions, vault references and step outputs it adds
 *   are returned for serve to authorise against the caller.
 */
export function judgeRunRecord(context: RunRecordContext): RunRecordJudgement {
  const { before, after } = context;
  const actions = new Set<"approve" | "signal">();
  const refuse = (refusal: string): RunRecordJudgement => ({
    refusal,
    actions,
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

  const beforeSteps = new Map<string, StepRunData>();
  for (const job of before?.jobs ?? []) {
    for (const step of job.steps) {
      beforeSteps.set(stepKey(job.jobName, step.stepName), step);
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
        actions,
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
  if (!same(before?.workflowDataArtifacts, after.workflowDataArtifacts)) {
    addedOutputs.push({
      jobName: "",
      stepName: "",
      output: undefined,
      dataArtifacts: after.workflowDataArtifacts ?? [],
    });
  }

  return {
    actions,
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

/**
 * The refusal for one step's change, or undefined; adds the actions its
 * transition needs to `actions`.
 */
function judgeStep(
  context: RunRecordContext,
  jobName: string,
  prior: StepRunData | undefined,
  step: StepRunData,
  kind: StepKind,
  runStatus: WorkflowRunData["status"],
  actions: Set<"approve" | "signal">,
): string | undefined {
  const decisionChanged = !same(prior?.approvalDecision, step.approvalDecision);
  if (decisionChanged) actions.add("approve");
  if (prior?.status === "waiting_approval") {
    for (
      const [field, was, is] of [
        ["prompt", prior.approvalPrompt, step.approvalPrompt],
        ["timeout", prior.approvalTimeout, step.approvalTimeout],
        ["start", prior.startedAt, step.startedAt],
      ] as const
    ) {
      if (!same(was, is)) {
        return `it changes a waiting approval gate's ${field}`;
      }
    }
  }
  const entered = TERMINAL.has(step.status) && prior?.status !== step.status;
  // A nested-call step also waits in waiting_approval while its child
  // waits; it ends when the child does, which the child's own record
  // decides.
  const nestedWait = step.nestedRun !== undefined;
  const gate = kind === "approval" ||
    (kind === "unknown" && !nestedWait &&
      (prior?.status === "waiting_approval" ||
        step.approvalDecision !== undefined));
  if (gate && entered) {
    const settledByCancel = step.status === "failed" &&
      step.settledByAbort === true &&
      (runStatus === "cancelled" || runStatus === "failed");
    const decidedBefore = !decisionChanged &&
      step.approvalDecision !== undefined &&
      step.approvalDecision.approved === (step.status === "succeeded");
    const timedOut = step.status === "failed" && prior !== undefined &&
      timeoutPassed(context, jobName, prior);
    if (!settledByCancel && !decidedBefore && !timedOut) {
      actions.add("approve");
    }
  }
  const signal = kind === "signal" ||
    (kind === "unknown" && prior !== undefined &&
      WAITING_SIGNAL.has(prior.status));
  if (signal && prior !== undefined && WAITING_SIGNAL.has(prior.status)) {
    const settledByCancel = step.status === "failed" &&
      step.settledByAbort === true &&
      (runStatus === "cancelled" || runStatus === "failed");
    const outcome = entered || !same(prior.output, step.output) ||
      !same(prior.wait, step.wait);
    if (outcome && !settledByCancel) actions.add("signal");
  } else if (
    signal && TERMINAL.has(step.status) && step.status !== "skipped" &&
    !same(prior?.output, step.output)
  ) {
    // A wait's outcome set without the record having shown it waiting.
    actions.add("signal");
  }
  return undefined;
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

/** JSON with object keys sorted, so equal values compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          ),
        )
        : v,
  ) ?? "undefined";
}
