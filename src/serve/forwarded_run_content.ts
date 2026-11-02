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
 * Content checks for a forwarded run record and run snapshot
 * (swamp-club#3922, swamp-club#4245). {@link judgeRunRecord} decides what a
 * record may set; this module supplies it with the stored workflow and what
 * serve holds (child runs' decisions, signal outcomes), and authorises,
 * against the caller and again under the forwarded lock, what the record adds
 * that serve acts on when it resumes the run: inputs and expressions it
 * evaluates, vault references it rehydrates, and step outputs it reads data
 * through. A record applies decisions and never makes them, so `approve` and
 * `signal` are not asked here: serve's handlers ask them when they decide.
 *
 * @module
 */

import type { AccessResource } from "../domain/access/access_decision_service.ts";
import type { ContentRefusal } from "../domain/datastore_v3/commit_authorization.ts";
import {
  type HeldChildRun,
  judgeRunRecord,
  runIdentityRefusal,
  type RunRecordJudgement,
} from "../domain/datastore_v3/content_bindings.ts";
import type { PutOp } from "../domain/datastore_v3/op.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import {
  analyzeContentExpressions,
  expressionsAddedByEdit,
} from "../domain/expressions/expression_references.ts";
import { parseStoredVaultReference } from "../domain/models/data_writer.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { parseParentRunLink } from "../domain/workflows/nested_run_ref.ts";
import { stepResourceRefs } from "../domain/workflows/step_output_resolver.ts";
import {
  isComputedStepTarget,
  type StepTarget,
  workflowStepTargets,
} from "../domain/workflows/step_targets.ts";
import { parseStoredWait } from "../domain/workflows/signal_wait.ts";
import type { WaitOutcome } from "../domain/workflows/signal_wait_records.ts";
import type { Workflow } from "../domain/workflows/workflow.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
import {
  type StepRunData,
  type WorkflowRunData,
  WorkflowRunSchema,
} from "../domain/workflows/workflow_run.ts";
import { parseEvaluatedWorkflowCache } from "../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { authorizeRunInputExpressions } from "./handlers/expression_reference_authorization.ts";
import {
  canonicalResources,
  modelAccessResource,
  unresolvedAccessResource,
  workflowAccessResource,
} from "./handlers/resource_resolution.ts";
import {
  isAdminOnlyModelType,
  isCallerVaultAuthorized,
  vaultAccessResource,
} from "./handlers/shared.ts";
import {
  type ContentCheckContext,
  parseRecord,
  refused,
} from "./forwarded_content_authorization.ts";

/**
 * A run snapshot: the evaluated workflow a run settles against, bound to
 * the run its intent names, and frozen once written: a cancel settles a
 * nested run against it, so a later put must hold the same bytes, which a
 * retried or replayed commit does. Nothing in it runs (resume re-evaluates
 * from the stored workflow), so the binding and run on the workflow are all
 * else it needs.
 */
export async function checkRunSnapshot(
  context: ContentCheckContext,
  op: PutOp,
): Promise<ContentRefusal | undefined> {
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  let workflow: Workflow;
  try {
    const cache = parseEvaluatedWorkflowCache(new TextDecoder().decode(bytes));
    if (cache === null) return refused(op, "its content is not a run snapshot");
    workflow = cache.workflow;
  } catch {
    return refused(op, "its content is not a run snapshot");
  }
  const identity = runIdentityRefusal(op.intent, { workflowId: workflow.id });
  if (identity !== undefined) return refused(op, identity);
  const prior = await context.prior(context.deps.partition, op.key.toString());
  if (prior.kind === "unreadable") {
    return refused(op, "the run snapshot it replaces cannot be read");
  }
  if (prior.kind === "present" && !sameBytes(prior.bytes, bytes)) {
    return refused(op, "it changes a run snapshot, which is frozen");
  }
  return undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** A run record: what {@link judgeRunRecord} returns, authorised. */
export async function checkRunRecord(
  context: ContentCheckContext,
  op: PutOp,
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (!("run" in intent)) return refused(op, "it is not a run's record");
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const after = WorkflowRunSchema.safeParse(parseRecord(bytes));
  if (!after.success) return refused(op, "its content is not a run record");
  const prior = await context.prior(context.deps.partition, op.key.toString());
  if (prior.kind === "unreadable") {
    return refused(op, "the run record it replaces cannot be read");
  }
  const before = prior.kind === "present"
    ? WorkflowRunSchema.safeParse(parseRecord(prior.bytes))
    : undefined;
  if (before !== undefined && !before.success) {
    return refused(op, "the run record it replaces cannot be parsed");
  }
  const { ctx } = context.deps;
  const workflow = await findWorkflowById(
    ctx.repoContext.workflowRepo,
    intent.run.workflowId,
  );
  const held = await heldByServe(
    context,
    intent.run,
    before?.data,
    after.data,
  );
  const judgement = judgeRunRecord({
    workflowId: intent.run.workflowId,
    runId: intent.run.runId,
    before: before?.data,
    after: after.data,
    workflowVaults: workflow?.vaults,
    heldChild: (jobName, step) =>
      held.children.get(heldKey(jobName, step.stepName)),
    heldOutcome: (waitId) => held.outcomes.get(waitId.toLowerCase()),
  });
  if (judgement.refusal !== undefined) return refused(op, judgement.refusal);

  // The record guard does not cover the control plane: an outcome is written
  // once, so the only move left to catch is its removal with the run.
  if (held.outcomes.size > 0) {
    const store = ctx.repoContext.signalWaits;
    context.recheckUnderLock(async () => {
      if (store === undefined || !store.supported) return false;
      for (const waitId of held.outcomes.keys()) {
        if ((await store.store.findOutcome(waitId)).kind !== "found") {
          return false;
        }
      }
      return true;
    });
  }

  const authorize = () =>
    additionsRefusal(
      context,
      op,
      workflow,
      before?.data,
      after.data,
      judgement,
    );
  const refusal = await authorize();
  if (refusal !== undefined) return refused(op, refusal);
  // Decided again under the lock: a grant revoked between here and the
  // append refuses the commit, as it does a handler's save.
  context.recheckUnderLock(async () => (await authorize()) === undefined);
  return undefined;
}

/** What serve holds that a record's steps may apply. */
interface HeldByServe {
  readonly children: ReadonlyMap<string, HeldChildRun>;
  readonly outcomes: ReadonlyMap<string, WaitOutcome>;
}

function heldKey(jobName: string, stepName: string): string {
  return JSON.stringify([jobName, stepName]);
}

/**
 * Reads what serve holds for the record's steps: the stored child run of each
 * step that links one, when it links back, and the stored outcome of each
 * wait whose step changes status. Bounded by the record's own step count.
 */
async function heldByServe(
  context: ContentCheckContext,
  run: { readonly workflowId: string; readonly runId: string },
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
): Promise<HeldByServe> {
  const children = new Map<string, HeldChildRun>();
  const outcomes = new Map<string, WaitOutcome>();
  const signalWaits = context.deps.ctx.repoContext.signalWaits;
  for (const job of after.jobs) {
    const priors = before?.jobs.find((j) => j.jobName === job.jobName)?.steps;
    for (const step of job.steps) {
      const prior = priors?.find((s) => s.stepName === step.stepName);
      if (prior?.status === step.status) continue;
      if (step.nestedRun !== undefined) {
        const child = await heldChildOf(context, run, job.jobName, step);
        if (child !== undefined) {
          children.set(heldKey(job.jobName, step.stepName), child);
        }
      }
      for (const raw of [prior?.wait, step.wait]) {
        const stored = parseStoredWait(raw);
        if (stored?.kind !== "valid" || signalWaits?.supported !== true) {
          continue;
        }
        const outcome = await signalWaits.store.findOutcome(stored.wait.id);
        if (
          outcome.kind === "found" && outcome.record.runId === run.runId &&
          outcome.record.workflowId === run.workflowId
        ) {
          outcomes.set(stored.wait.id.toLowerCase(), outcome.record);
        }
      }
    }
  }
  return { children, outcomes };
}

/**
 * The stored record of the child `step` links to, when that child's parent
 * link names this run, job and step. Read through `context.prior`, so a child
 * that moves before the commit lands sends the commit back to be judged again.
 */
async function heldChildOf(
  context: ContentCheckContext,
  run: { readonly workflowId: string; readonly runId: string },
  jobName: string,
  step: StepRunData,
): Promise<HeldChildRun | undefined> {
  const link = step.nestedRun as
    | { workflowId?: unknown; runId?: unknown }
    | null;
  if (link === null || typeof link !== "object") return undefined;
  if (typeof link.workflowId !== "string" || typeof link.runId !== "string") {
    return undefined;
  }
  let partition;
  try {
    partition = partitionOf({
      kind: "run",
      workflowId: link.workflowId,
      runId: link.runId,
    });
  } catch {
    return undefined;
  }
  const record = await context.prior(
    partition,
    `workflow-runs/${link.workflowId.toLowerCase()}/workflow-run-${link.runId.toLowerCase()}.yaml`,
  );
  if (record.kind !== "present") return undefined;
  const child = WorkflowRunSchema.safeParse(parseRecord(record.bytes));
  if (!child.success) return undefined;
  const parent = parseParentRunLink(child.data.parentRun);
  if (
    parent?.kind !== "valid" ||
    parent.ref.workflowId.toLowerCase() !== run.workflowId ||
    parent.ref.runId.toLowerCase() !== run.runId ||
    parent.ref.jobName !== jobName ||
    parent.ref.stepName !== (step.forEachTemplate ?? step.stepName) &&
      parent.ref.stepName !== step.stepName
  ) {
    return undefined;
  }
  return {
    decisions: child.data.jobs.flatMap((j) =>
      j.steps.flatMap((s) =>
        s.approvalDecision === undefined ? [] : [s.approvalDecision]
      )
    ),
  };
}

/**
 * Why what a record adds may not stand, or undefined: decided against the
 * caller, before the lock and again under it.
 */
async function additionsRefusal(
  context: ContentCheckContext,
  op: PutOp,
  workflow: Workflow | null,
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
  judgement: RunRecordJudgement,
): Promise<string | undefined> {
  const intent = op.intent;
  if (!("run" in intent)) return "it is not a run's record";
  const { ctx } = context.deps;
  const targets = workflow === null ? [] : workflowStepTargets(workflow);
  const authority = context.authority;
  const runOn: AccessResource = workflow === null
    ? unresolvedAccessResource("workflow", intent.run.workflowId)
    : workflowAccessResource(workflow);

  if (before === undefined && after.parentRun !== undefined) {
    const parent = await parentRefusal(context, after.parentRun);
    if (parent !== undefined) return parent;
  }

  // What serve evaluates on resume is authorised as run inputs are: data it
  // reads must be readable by the caller, and env needs write.
  const expressions = [
    ...(judgement.inputsChanged
      ? expressionsAddedByEdit(
        analyzeContentExpressions(before?.inputs ?? {}),
        analyzeContentExpressions(after.inputs ?? {}),
        false,
      )
      : []),
    ...analyzeContentExpressions(judgement.addedDeferred),
    ...analyzeContentExpressions(judgement.addedInherited),
  ];
  const refusal = await authorizeRunInputExpressions(
    authority,
    ctx,
    expressions,
    runOn,
  );
  if (refusal !== undefined) return refusal.message;

  // A vault reference the record holds is rehydrated to its secret on
  // resume: the caller must be able to read it.
  const references = [
    ...judgement.addedReferences.flatMap((entry) =>
      isReference(entry) ? [entry] : []
    ),
    ...(judgement.inputsChanged ? storedReferences(after.inputs) : []),
  ];
  for (const { vaultName, key } of references) {
    if (
      !isCallerVaultAuthorized(context.deps.caller, context.deps.requestId, {
        vaultName,
        action: "read",
        existing: vaultAccessResource(vaultName),
        key,
      }, ctx)
    ) {
      return `not authorized to read vault:${vaultName}`;
    }
  }

  for (const added of judgement.addedOutputs) {
    const outputRefusal = await outputRefusalOf(
      context,
      intent.run,
      targets,
      added.jobName,
      after.jobs
        .find((job) => job.jobName === added.jobName)?.steps
        .find((step) => step.stepName === added.stepName),
      added.output,
      added.dataArtifacts,
    );
    if (outputRefusal !== undefined) return outputRefusal;
  }
  return undefined;
}

/**
 * Why a run's first record may not name `raw` as its parent, or undefined:
 * the parent must be a run that exists and has not finished, of a
 * workflow the caller may run. A parent records its wait on the child only
 * once the child suspends, so no link back is required here; the cascade
 * checks both directions before it acts on a parent.
 */
async function parentRefusal(
  context: ContentCheckContext,
  raw: unknown,
): Promise<string | undefined> {
  const link = parseParentRunLink(raw);
  if (link === undefined || link.kind !== "valid") {
    return "its parent run is not a run reference";
  }
  const { workflowId, runId } = link.ref;
  const parent = await context.prior(
    partitionOf({ kind: "run", workflowId, runId }),
    `workflow-runs/${workflowId.toLowerCase()}/workflow-run-${runId.toLowerCase()}.yaml`,
  );
  if (parent.kind !== "present") return "its parent run does not exist";
  const parsed = WorkflowRunSchema.safeParse(parseRecord(parent.bytes));
  if (!parsed.success) return "its parent run cannot be read";
  if (["succeeded", "failed", "cancelled"].includes(parsed.data.status)) {
    return "its parent run has finished";
  }
  const workflow = await findWorkflowById(
    context.deps.ctx.repoContext.workflowRepo,
    workflowId,
  );
  const resource = workflow === null
    ? unresolvedAccessResource("workflow", workflowId)
    : workflowAccessResource(workflow);
  return context.authority.allows("run", resource)
    ? undefined
    : `not authorized to run workflow:${resource.name}`;
}

function isReference(
  entry: unknown,
): entry is { vaultName: string; key: string } {
  return entry !== null && typeof entry === "object" &&
    typeof (entry as { vaultName?: unknown }).vaultName === "string" &&
    typeof (entry as { key?: unknown }).key === "string";
}

/** Every stored vault reference a value holds, at any depth. */
function storedReferences(
  value: unknown,
): { vaultName: string; key: string }[] {
  const found: { vaultName: string; key: string }[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      const reference = parseStoredVaultReference(v);
      if (reference !== undefined) found.push(reference);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v !== null && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return found;
}

/**
 * Why a step output a record adds may not stand, or undefined. Serve reads
 * the data a model_method output names when it resumes the run, so each
 * reference must name what the stored step runs, when the step names it
 * literally, or a behavior the caller may run; and the caller must be able
 * to read its data, as workflow history decides. A nested workflow output
 * must be the child run the step's link names.
 */
async function outputRefusalOf(
  context: ContentCheckContext,
  run: { readonly workflowId: string; readonly runId: string },
  targets: readonly StepTarget[],
  jobName: string,
  step: StepRunData | undefined,
  output: unknown,
  dataArtifacts: readonly unknown[],
): Promise<string | undefined> {
  const { ctx } = context.deps;
  if (
    output !== null && typeof output === "object" &&
    (output as { type?: unknown }).type === "workflow"
  ) {
    return await childOutputRefusal(context, run, jobName, step, output);
  }
  const target = step === undefined ? undefined : literalTarget(
    targets,
    jobName,
    step.forEachTemplate ?? step.stepName,
  );
  const bound = target === undefined
    ? undefined
    : await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      target.kind === "model" ? target.modelIdOrName : target.modelName,
    ).catch(() => null);
  const owners = canonicalResources(ctx);
  const refs = [
    ...stepResourceRefs(output),
    ...dataArtifacts.flatMap((artifact) => stepResourceRefs(artifact)),
  ];
  for (const ref of refs) {
    if (bound !== undefined) {
      if (
        bound === null || bound.definition.id !== ref.modelId ||
        bound.type.normalized !== ref.modelType
      ) {
        return "a step output names data of a behavior its step does not run";
      }
    } else {
      const named = await findDefinitionByIdOrName(
        ctx.repoContext.definitionRepo,
        ref.modelId,
      ).catch(() => null);
      if (named === null) {
        return "a step output names data of a behavior that does not exist";
      }
      const restricted = ctx.authConfig.restrictedModelTypes;
      const runnable = isAdminOnlyModelType(
          undefined,
          named.type.normalized,
          restricted,
        )
        ? context.authority.allows("admin", {
          kind: "access",
          name: "*",
          fields: modelAccessResource(named).fields,
        })
        : context.authority.allows("run", modelAccessResource(named));
      if (!runnable) {
        return `not authorized to run model:${named.definition.name}`;
      }
    }
    for (const resource of await owners.dataOwners(ref)) {
      if (!context.authority.allows("read", resource)) {
        return `not authorized to read data:${resource.name}`;
      }
    }
  }
  return undefined;
}

/**
 * Why a nested workflow output may not stand, or undefined. Serve reads the
 * child run's outputs into later steps when it resumes the run, so the
 * child must be this step's own, as the nested-run cascade decides it: the
 * child's record exists and its parent link names this run, job and step,
 * and a link on the step, if any, names that child. The caller must also be
 * able to read the child's workflow, whose outputs it exposes. A link either
 * record holds alone proves nothing: a forwarded record may set it.
 */
async function childOutputRefusal(
  context: ContentCheckContext,
  run: { readonly workflowId: string; readonly runId: string },
  jobName: string,
  step: StepRunData | undefined,
  output: object,
): Promise<string | undefined> {
  const child = output as { workflowId?: unknown; runId?: unknown };
  const refusal = "a nested workflow output is not this step's child run";
  if (
    step === undefined || typeof child.workflowId !== "string" ||
    typeof child.runId !== "string"
  ) {
    return refusal;
  }
  const link = step.nestedRun as
    | { workflowId?: unknown; runId?: unknown }
    | undefined;
  if (
    link !== undefined &&
    (link.workflowId !== child.workflowId || link.runId !== child.runId)
  ) {
    return refusal;
  }
  let partition;
  try {
    partition = partitionOf({
      kind: "run",
      workflowId: child.workflowId,
      runId: child.runId,
    });
  } catch {
    return refusal;
  }
  const record = await context.prior(
    partition,
    `workflow-runs/${child.workflowId.toLowerCase()}/workflow-run-${child.runId.toLowerCase()}.yaml`,
  );
  if (record.kind !== "present") return refusal;
  const parsed = WorkflowRunSchema.safeParse(parseRecord(record.bytes));
  if (!parsed.success) return refusal;
  const parent = parseParentRunLink(parsed.data.parentRun);
  if (
    parent?.kind !== "valid" ||
    parent.ref.workflowId.toLowerCase() !== run.workflowId ||
    parent.ref.runId.toLowerCase() !== run.runId ||
    parent.ref.jobName !== jobName ||
    parent.ref.stepName !== (step.forEachTemplate ?? step.stepName) &&
      parent.ref.stepName !== step.stepName
  ) {
    return refusal;
  }
  const workflow = await findWorkflowById(
    context.deps.ctx.repoContext.workflowRepo,
    child.workflowId,
  );
  const resource = workflow === null
    ? unresolvedAccessResource("workflow", child.workflowId)
    : workflowAccessResource(workflow);
  return context.authority.allows("read", resource)
    ? undefined
    : `not authorized to read workflow:${resource.name}`;
}

/** The stored step's target when it names its behavior literally. */
function literalTarget(
  targets: readonly StepTarget[],
  jobName: string,
  stepName: string,
): Exclude<StepTarget, { kind: "workflow" }> | undefined {
  const location = `jobs[${JSON.stringify([jobName, 0])}].steps[${
    JSON.stringify([stepName, 0])
  }]`;
  const target = targets.find((t) => t.location === location);
  if (
    target === undefined || target.kind === "workflow" ||
    isComputedStepTarget(target)
  ) {
    return undefined;
  }
  return target;
}
