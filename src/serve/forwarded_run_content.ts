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

import type { AccessResource } from "../domain/access/access_decision_service.ts";
import {
  type ContentRefusal,
  RUN_INITIATOR_MISMATCH_REASON,
} from "../domain/datastore_v3/commit_authorization.ts";
import { principalToString } from "../domain/access/principal.ts";
import {
  type HeldChildRun,
  judgeRunRecord,
  judgeRunStart,
  runIdentityRefusal,
  runInitiatorRefusal,
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
import { createWorkflowRunId } from "../domain/workflows/workflow_id.ts";
import { parseParentRunLink } from "../domain/workflows/nested_run_ref.ts";
import { stepResourceRefs } from "../domain/workflows/step_output_resolver.ts";
import {
  isComputedStepTarget,
  type StepTarget,
  workflowStepTargets,
} from "../domain/workflows/step_targets.ts";
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
 * frozen once written: a cancel settles a nested run against it, so a later put
 * must hold the same bytes, which a retried or replayed commit does. Nothing in
 * it runs
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
  // A run id names one run: some lookups and deletes select by it alone, so a
  // first record reusing one would reach the run that holds it, in any workflow.
  if (before === undefined) {
    const initiator = await initiatorRefusal(context, op, after.data);
    if (initiator !== undefined) return initiator;
  }
  if (before === undefined) {
    const isOurs = async () => {
      const holder = await ctx.repoContext.workflowRunRepo.findGlobalById(
        createWorkflowRunId(intent.run.runId),
      );
      return holder === null || holder.workflowId === intent.run.workflowId;
    };
    if (!(await isOurs())) {
      return refused(op, "its run id is another workflow's run");
    }
    context.recheckUnderLock(isOurs);
  }
  const children = await heldChildren(
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
    heldChild: (jobName, step) => children.get(heldKey(jobName, step.stepName)),
    storedStepIsNested: (jobName, step) => {
      const steps = workflow?.jobs.find((job) => job.name === jobName)?.steps;
      const stored = steps?.find((s) => s.name === step.stepName) ??
        steps?.find((s) =>
          s.name === step.forEachTemplate && s.forEach !== undefined
        );
      return stored?.task.data.type === "workflow";
    },
  });
  if (judgement.refusal !== undefined) return refused(op, judgement.refusal);

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

/** the stored record is read through prior, so the lock re-checks it */
export async function checkRunStart(
  context: ContentCheckContext,
  op: PutOp,
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (!("run" in intent)) return refused(op, "it is not a run's step start");
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const prior = await context.prior(
    context.deps.partition,
    runRecordKey(intent.run.workflowId, intent.run.runId),
  );
  if (prior.kind === "unreadable") {
    return refused(op, "its run's record cannot be read");
  }
  const record = prior.kind === "present"
    ? WorkflowRunSchema.safeParse(parseRecord(prior.bytes))
    : undefined;
  if (record !== undefined && !record.success) {
    return refused(op, "its run's record cannot be parsed");
  }
  const segments = op.key.toString().split("/");
  const refusal = judgeRunStart({
    workflowId: intent.run.workflowId,
    runId: intent.run.runId,
    fileName: segments[segments.length - 1],
    content: parseRecord(bytes),
    record: record?.data,
  });
  return refusal === undefined ? undefined : refused(op, refusal);
}

function runRecordKey(workflowId: string, runId: string): string {
  return `workflow-runs/${workflowId.toLowerCase()}/workflow-run-${runId.toLowerCase()}.yaml`;
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function heldKey(jobName: string, stepName: string): string {
  return JSON.stringify([jobName, stepName]);
}

async function heldChildren(
  context: ContentCheckContext,
  run: { readonly workflowId: string; readonly runId: string },
  before: WorkflowRunData | undefined,
  after: WorkflowRunData,
): Promise<ReadonlyMap<string, HeldChildRun>> {
  const children = new Map<string, HeldChildRun>();
  for (const job of after.jobs) {
    const priors = before?.jobs.find((j) => j.jobName === job.jobName)?.steps;
    for (const step of job.steps) {
      const prior = priors?.find((s) => s.stepName === step.stepName);
      if (prior?.status === step.status || step.nestedRun === undefined) {
        continue;
      }
      const child = await heldChildOf(context, run, job.jobName, step);
      if (child !== undefined) {
        children.set(heldKey(job.jobName, step.stepName), child);
      }
    }
  }
  return children;
}

/**
 * read through context.prior, so a child that moves before the commit lands
 * sends the commit back to be judged again
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
    runRecordKey(link.workflowId, link.runId),
  );
  if (record.kind !== "present") return undefined;
  const child = WorkflowRunSchema.safeParse(parseRecord(record.bytes));
  if (!child.success) return undefined;
  const parent = parseParentRunLink(child.data.parentRun);
  if (
    parent?.kind !== "valid" ||
    !sameId(parent.ref.workflowId, run.workflowId) ||
    !sameId(parent.ref.runId, run.runId) ||
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
        method: "get",
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
 * a parent records its wait on the child only once the child suspends, so no
 * link back is required here; the cascade checks both directions before it acts
 * on a parent
 */
type StoredParent =
  | { readonly refusal: string }
  | { readonly parent: WorkflowRunData };

async function storedParentOf(
  context: ContentCheckContext,
  raw: unknown,
): Promise<StoredParent> {
  const link = parseParentRunLink(raw);
  if (link === undefined || link.kind !== "valid") {
    return { refusal: "its parent run is not a run reference" };
  }
  const { workflowId, runId } = link.ref;
  const parent = await context.prior(
    partitionOf({ kind: "run", workflowId, runId }),
    runRecordKey(workflowId, runId),
  );
  if (parent.kind !== "present") {
    return { refusal: "its parent run does not exist" };
  }
  const parsed = WorkflowRunSchema.safeParse(parseRecord(parent.bytes));
  if (!parsed.success) return { refusal: "its parent run cannot be read" };
  return { parent: parsed.data };
}

async function parentRefusal(
  context: ContentCheckContext,
  raw: unknown,
): Promise<string | undefined> {
  const stored = await storedParentOf(context, raw);
  if ("refusal" in stored) return stored.refusal;
  const { parent } = stored;
  if (["succeeded", "failed", "cancelled"].includes(parent.status)) {
    return "its parent run has finished";
  }
  const workflow = await findWorkflowById(
    context.deps.ctx.repoContext.workflowRepo,
    parent.workflowId,
  );
  const resource = workflow === null
    ? unresolvedAccessResource("workflow", parent.workflowId)
    : workflowAccessResource(workflow);
  return context.authority.allows("run", resource)
    ? undefined
    : `not authorized to run workflow:${resource.name}`;
}

/** a parent that cannot be read is refused by parentRefusal, not here */
async function initiatorRefusal(
  context: ContentCheckContext,
  op: PutOp,
  after: WorkflowRunData,
): Promise<ContentRefusal | undefined> {
  const caller = context.deps.caller.principal;
  let parent: WorkflowRunData | undefined;
  if (after.parentRun !== undefined) {
    const stored = await storedParentOf(context, after.parentRun);
    if ("refusal" in stored) return undefined;
    parent = stored.parent;
  }
  const refusal = runInitiatorRefusal({
    initiatedBy: after.initiatedBy,
    caller: caller === null ? undefined : principalToString(caller),
    ...(parent === undefined ? {} : { parent }),
  });
  return refusal === undefined ? undefined : {
    ...refused(op, refusal),
    reason: RUN_INITIATOR_MISMATCH_REASON,
  };
}

function isReference(
  entry: unknown,
): entry is { vaultName: string; key: string } {
  return entry !== null && typeof entry === "object" &&
    typeof (entry as { vaultName?: unknown }).vaultName === "string" &&
    typeof (entry as { key?: unknown }).key === "string";
}

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
 * serve reads the data a model_method output names on resume, so each reference
 * must name what the stored step runs or a behavior the caller may run, and its
 * data must be readable by the caller
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
 * serve reads the child run's outputs into later steps on resume, so the child
 * must be this step's own; a link either record holds alone proves nothing,
 * since a forwarded record may set it
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
    runRecordKey(child.workflowId, child.runId),
  );
  if (record.kind !== "present") return refusal;
  const parsed = WorkflowRunSchema.safeParse(parseRecord(record.bytes));
  if (!parsed.success) return refusal;
  const parent = parseParentRunLink(parsed.data.parentRun);
  if (
    parent?.kind !== "valid" ||
    !sameId(parent.ref.workflowId, run.workflowId) ||
    !sameId(parent.ref.runId, run.runId) ||
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
