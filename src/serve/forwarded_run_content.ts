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
 * (swamp-club#3922). {@link judgeRunRecord} decides what a record may set
 * and which transitions need `approve` or `signal`; this module supplies it
 * with the stored workflow and authorises, against the caller, what the
 * record adds that serve acts on when it resumes the run: inputs and
 * expressions it evaluates, vault references it rehydrates, and step
 * outputs it reads data through.
 *
 * @module
 */

import type { AccessResource } from "../domain/access/access_decision_service.ts";
import type { ContentRefusal } from "../domain/datastore_v3/commit_authorization.ts";
import {
  judgeRunRecord,
  runIdentityRefusal,
  type StepKind,
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
import type { Workflow } from "../domain/workflows/workflow.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
import {
  type StepRunData,
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
 * the run its intent names. Nothing in it runs (resume re-evaluates from
 * the stored workflow), so the binding and run on the workflow are all it
 * needs.
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
  return identity === undefined ? undefined : refused(op, identity);
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
  const targets = workflow === null ? [] : workflowStepTargets(workflow);
  const judgement = judgeRunRecord({
    workflowId: intent.run.workflowId,
    runId: intent.run.runId,
    before: before?.data,
    after: after.data,
    stepKind: (jobName, step) => stepKindOf(workflow, jobName, step),
    definitionSteps: (jobName) =>
      workflow?.jobs.find((job) => job.name === jobName)?.steps,
    workflowVaults: workflow?.vaults,
    isServeInstance: (id) =>
      ctx.instanceId !== undefined && id === ctx.instanceId,
    now: context.now(),
  });
  if (judgement.refusal !== undefined) return refused(op, judgement.refusal);

  const authority = context.authority;
  const runOn: AccessResource = workflow === null
    ? unresolvedAccessResource("workflow", intent.run.workflowId)
    : workflowAccessResource(workflow);
  for (const action of judgement.actions) {
    if (!authority.allows(action, runOn)) {
      return refused(op, `not authorized to ${action} workflow:${runOn.name}`);
    }
  }

  if (before === undefined && after.data.parentRun !== undefined) {
    const parent = await parentRefusal(context, after.data.parentRun);
    if (parent !== undefined) return refused(op, parent);
  }

  // What serve evaluates on resume is authorised as run inputs are: data it
  // reads must be readable by the caller, and env needs write.
  const expressions = [
    ...(judgement.inputsChanged
      ? expressionsAddedByEdit(
        analyzeContentExpressions(before?.data.inputs ?? {}),
        analyzeContentExpressions(after.data.inputs ?? {}),
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
  if (refusal !== undefined) return refused(op, refusal.message);

  // A vault reference the record holds is rehydrated to its secret on
  // resume: the caller must be able to read it.
  const references = [
    ...judgement.addedReferences.flatMap((entry) =>
      isReference(entry) ? [entry] : []
    ),
    ...(judgement.inputsChanged ? storedReferences(after.data.inputs) : []),
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
      return refused(op, `not authorized to read vault:${vaultName}`);
    }
  }

  for (const added of judgement.addedOutputs) {
    const outputRefusal = await outputRefusalOf(
      context,
      targets,
      added.jobName,
      after.data.jobs
        .find((job) => job.jobName === added.jobName)?.steps
        .find((step) => step.stepName === added.stepName),
      added.output,
      added.dataArtifacts,
    );
    if (outputRefusal !== undefined) return refused(op, outputRefusal);
  }
  return undefined;
}

/** What a run's step is, by the stored workflow's step of its name. */
function stepKindOf(
  workflow: Workflow | null,
  jobName: string,
  step: StepRunData,
): StepKind {
  const job = workflow?.jobs.find((candidate) => candidate.name === jobName);
  const defined = job?.steps.find((s) => s.name === step.stepName) ??
    (step.forEachTemplate === undefined
      ? undefined
      : job?.steps.find((s) => s.name === step.forEachTemplate));
  if (defined === undefined) return "unknown";
  switch (defined.task.data.type) {
    case "manual_approval":
      return "approval";
    case "wait_for_signal":
      return "signal";
    default:
      return "other";
  }
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
    const child = output as { workflowId?: unknown; runId?: unknown };
    const link = step?.nestedRun as
      | { workflowId?: unknown; runId?: unknown }
      | undefined;
    if (
      link === undefined || child.workflowId !== link.workflowId ||
      child.runId !== link.runId
    ) {
      return "a nested workflow output is not the child run its step links";
    }
    return undefined;
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
