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
import { unresolvedAccessResource } from "../domain/access/access_resources.ts";
import { createWorkflowRunId } from "../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../domain/workflows/repositories.ts";
import {
  resolveRecordedWorkflow,
  resolveWorkflowTarget,
} from "./handlers/resource_resolution.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  isCallerAuthorized,
  isRestrictedCommand,
} from "./handlers/shared.ts";
import type { HeldRunWorkflow } from "./run_cancel_registry.ts";

export const WORKFLOW_CANCEL_COMMAND = "workflow.cancel";

export type RunCancelHolders = Pick<
  ConnectionContext,
  | "cancelRegistry"
  | "activeRunRegistry"
  | "scheduledExecution"
  | "webhookRuns"
>;

/** a cancel is decided on this; undefined when the lookup failed, which refuses */
export async function runCancelResource(
  workflowRepo: WorkflowRepository,
  target: HeldRunWorkflow,
): Promise<AccessResource | undefined> {
  const resolution = target.id
    ? await resolveRecordedWorkflow(workflowRepo, target.id, target.name)
    : await resolveWorkflowTarget(workflowRepo, target.name);
  if (resolution.status === "failed") return undefined;
  return resolution.status === "found"
    ? resolution.resource
    : unresolvedAccessResource("workflow", target.name);
}

/** a run held outside the active-run registry, which has its own cancel path */
export function workflowHeldOutsideActiveRuns(
  holders: RunCancelHolders,
  runId: string,
): HeldRunWorkflow | undefined {
  const scheduled = holders.scheduledExecution?.workflowOfRun(runId);
  const webhook = holders.webhookRuns?.workflowOfRun(runId);
  return holders.cancelRegistry?.workflowOf("workflow-run", runId) ??
    scheduled ??
    webhook;
}

export function abortRunHeldOutsideActiveRuns(
  holders: RunCancelHolders,
  runId: string,
  reason: string,
): boolean {
  return holders.cancelRegistry?.cancel("workflow-run", runId, reason) ||
    holders.scheduledExecution?.cancelByRunId(runId, reason) ||
    holders.webhookRuns?.cancelByRunId(runId, reason) ||
    false;
}

type HeldRun = { workflow: HeldRunWorkflow } | { methodRun: true };

// in cancelExecution's order, which aborts the first of these that has the run
function heldRun(
  holders: RunCancelHolders,
  runId: string,
): HeldRun | undefined {
  const attached = holders.cancelRegistry?.workflowOf("workflow-run", runId);
  if (attached) return { workflow: attached };
  const active = holders.activeRunRegistry?.get(runId);
  if (active) {
    return active.kind === "method-run" ? { methodRun: true } : {
      workflow: { id: active.resourceId, name: active.resourceName },
    };
  }
  const other = workflowHeldOutsideActiveRuns(holders, runId);
  return other ? { workflow: other } : undefined;
}

function sameHeldRun(a: HeldRun | undefined, b: HeldRun | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function storedRunWorkflow(
  ctx: Pick<ConnectionContext, "repoContext">,
  runId: string,
): Promise<HeldRunWorkflow | undefined> {
  const found = await ctx.repoContext.workflowRunRepo.findGlobalById(
    createWorkflowRunId(runId),
  );
  if (!found) return undefined;
  const { run, workflowId } = found;
  const workflow = await ctx.repoContext.workflowRepo.findById(workflowId);
  return { id: run.workflowId, name: workflow?.name ?? run.workflowName };
}

export type RunCancelDecision = "allowed" | "refused" | "absent";

// decides on what would be aborted, never a stored record while a holder has the
// id (a member can write one under a workflow they hold run on); the caller
// reaches cancelExecution's holders with no await after this, or decides again
export async function decideRunCancel(
  ctx: ConnectionContext,
  caller: AccessCaller,
  runId: string,
  requestId: string,
): Promise<RunCancelDecision> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const held = heldRun(ctx, runId);
    if (held && "methodRun" in held) return "absent";
    const target = held?.workflow ?? await storedRunWorkflow(ctx, runId);
    if (!target) {
      if (heldRun(ctx, runId) !== undefined) continue;
      return "absent";
    }
    const resource = await runCancelResource(
      ctx.repoContext.workflowRepo,
      target,
    );
    if (!resource) return "absent";
    if (!isCallerAuthorized(caller, requestId, "run", resource, ctx)) {
      return "refused";
    }
    if (sameHeldRun(heldRun(ctx, runId), held)) return "allowed";
  }
  return "absent";
}

function runCommandDecider(
  ctx: ConnectionContext,
  caller: AccessCaller,
  command: string,
): (target: HeldRunWorkflow) => Promise<boolean> {
  if (ctx.authConfig.mode === "none") return () => Promise.resolve(true);
  const admin = callerResourceDecider(caller, "admin", ctx);
  const runnable = callerResourceDecider(caller, "run", ctx);
  if (
    isRestrictedCommand(command, ctx.authConfig.restrictedCommands) &&
    !admin({ kind: "access", name: command, fields: {} })
  ) {
    return () => Promise.resolve(false);
  }
  const decided = new Map<string, Promise<boolean>>();
  return (target) => {
    const key = JSON.stringify([target.id, target.name]);
    let found = decided.get(key);
    if (!found) {
      found = runCancelResource(ctx.repoContext.workflowRepo, target)
        .then((resource) => resource !== undefined && runnable(resource))
        .catch(() => false);
      decided.set(key, found);
    }
    return found;
  };
}

/** what swamp workflow cancel --server allows: admin on every resource, or run */
export function runCancelDecider(
  ctx: ConnectionContext,
  caller: AccessCaller,
): (target: HeldRunWorkflow) => Promise<boolean> {
  const isAdmin = callerResourceDecider(caller, "admin", ctx)({
    kind: "access",
    name: "*",
    fields: {},
  });
  if (isAdmin) return () => Promise.resolve(true);
  return runCommandDecider(ctx, caller, WORKFLOW_CANCEL_COMMAND);
}

export function runResumeDecider(
  ctx: ConnectionContext,
  caller: AccessCaller,
): (target: HeldRunWorkflow) => Promise<boolean> {
  return runCommandDecider(ctx, caller, "workflow.resume");
}
