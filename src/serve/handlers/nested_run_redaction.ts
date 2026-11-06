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

import type { Principal } from "../../domain/access/principal.ts";
import {
  type NestedRunPendingError,
  NestedRunUnreadableError,
} from "../../domain/workflows/nested_run_link.ts";
import {
  nestedWaitGateOf,
  orphanedNestedRunOf,
} from "../../libswamp/workflows/nested_runs.ts";
import type { NestedCascadeResult } from "../../libswamp/workflows/nested_cascade.ts";
import type { OrphanedNestedRunError } from "../../domain/workflows/orphaned_nested_run.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import type { SerializedEvent } from "../protocol.ts";
import { CanonicalResources } from "./resource_resolution.ts";
import {
  type AccessCaller,
  accessCallerOf,
  callerResourceDecider,
  type ConnectionContext,
} from "./shared.ts";

export interface NamedWorkflow {
  workflowId: string;
  workflowName: string;
}

/**
 * the fields linking a run to its parent or nested runs are returned only when
 * this allows the workflow they name; child identity a run already carried
 * (succeeded step output, forwarded child events) is unchanged
 */
export function nestedRunReadDecider(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
  // a request passes its own, so links resolve from the request's one walk; a
  // run stream keeps the live repository, as a per-request view would keep the
  // extension workflows it first read for the whole stream
  canonical?: CanonicalResources,
): (workflow: NamedWorkflow) => Promise<boolean> {
  return callerNestedRunReadDecider(
    ctx,
    accessCallerOf(socket, principal),
    canonical,
  );
}

export function callerNestedRunReadDecider(
  ctx: ConnectionContext,
  caller: AccessCaller,
  canonical?: CanonicalResources,
): (workflow: NamedWorkflow) => Promise<boolean> {
  if (ctx.authConfig.mode === "none") return () => Promise.resolve(true);
  const owners = canonical ?? new CanonicalResources(
    ctx.repoContext.definitionRepo,
    ctx.repoContext.workflowRepo,
  );
  const allows = callerResourceDecider(caller, "read", ctx);
  const decided = new Map<string, Promise<boolean>>();
  return (workflow) => {
    const key = JSON.stringify([workflow.workflowId, workflow.workflowName]);
    let found = decided.get(key);
    if (!found) {
      found = owners.workflowOwners(
        workflow.workflowId,
        workflow.workflowName,
      ).then((resources) => resources.length > 0 && resources.every(allows))
        .catch(() => false);
      decided.set(key, found);
    }
    return found;
  };
}

export async function redactParentRun<
  T extends {
    parentRun?: NamedWorkflow;
    parentWaiting?: boolean;
    parentEnded?: boolean;
    parentMissing?: boolean;
  },
>(
  row: T,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<void> {
  if (row.parentRun && !(await canRead(row.parentRun))) {
    delete row.parentRun;
    delete row.parentWaiting;
    delete row.parentEnded;
    delete row.parentMissing;
  }
}

export async function readableNestedRuns<T extends { workflowName: string }>(
  runs: T[] | undefined,
  workflowIdOf: (run: T) => string | undefined,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<T[] | undefined> {
  if (!runs) return undefined;
  const kept: T[] = [];
  for (const run of runs) {
    const workflowId = workflowIdOf(run);
    if (
      workflowId !== undefined &&
      await canRead({ workflowId, workflowName: run.workflowName })
    ) {
      kept.push(run);
    }
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * what a step whose nested run is hidden reports instead of its own error,
 * which names that run
 */
const HIDDEN_NESTED_STEP_ERROR =
  "The step's nested workflow run is not shown: you may not read its workflow.";

export async function redactRunViewLinks(
  view: WorkflowRunView,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<void> {
  await redactParentRun(view, canRead);
  const nestedWaits = await readableNestedRuns(
    view.nestedWaits,
    (w) => w.workflowId,
    canRead,
  );
  if (nestedWaits) view.nestedWaits = nestedWaits;
  else delete view.nestedWaits;
  for (const job of view.jobs ?? []) {
    for (const step of job.steps) {
      if (step.nestedRun && !(await canRead(step.nestedRun))) {
        delete step.nestedRun;
        if (step.error !== undefined) step.error = HIDDEN_NESTED_STEP_ERROR;
      }
    }
  }
}

/**
 * a buffered event is shared by every client attached to the run, so an event
 * that needs a change is copied first; a nested run's own events forwarded into
 * its parent's stream are left as they are
 */
export async function redactStreamEvent(
  event: SerializedEvent,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<SerializedEvent> {
  if (event.kind === "superseded_runs" && event.detachedNestedRuns) {
    const copy = structuredClone(event);
    const detached = await readableNestedRuns(
      copy.detachedNestedRuns as NestedRunEntry[],
      (d) => d.workflowId,
      canRead,
    );
    if (detached) copy.detachedNestedRuns = detached;
    else delete copy.detachedNestedRuns;
    return copy;
  }
  if (event.kind === "step_failed") {
    // a wait_key_held failure names the wait holding the key, which can be in
    // another workflow's run: only to a reader of that workflow. Removing it
    // builds a new object, so the shared buffered event is never changed.
    let failed = event;
    if (
      "waitKeyHolder" in event &&
      !(isNamedWorkflow(event.waitKeyHolder) &&
        await canRead(event.waitKeyHolder))
    ) {
      const { waitKeyHolder: _hidden, ...rest } = event;
      failed = rest as SerializedEvent;
    }
    if (isNamedWorkflow(failed.nestedRun)) {
      if (await canRead(failed.nestedRun)) return failed;
      const { nestedRun: _hidden, ...rest } = failed;
      return { ...rest, error: HIDDEN_NESTED_STEP_ERROR };
    }
    // a step failure carries no run view to redact
    return failed;
  }
  if (!isRunView(event.run)) return event;
  const copy = structuredClone(event) as SerializedEvent & {
    run: WorkflowRunView;
  };
  await redactRunViewLinks(copy.run, canRead);
  // a suspension on a nested run names it beside the step that waits on it, and
  // goes when that step's link went
  if (copy.kind === "suspended" && copy.nested !== undefined) {
    const step = copy.run.jobs.find((j) => j.name === copy.jobId)?.steps
      .find((s) => s.name === copy.stepId);
    if (!step?.nestedRun) delete copy.nested;
  }
  // a nested run's open wait is named only to a reader of the workflow the wait
  // belongs to, which can be a grandchild's in another workflow than the run
  // the step waits on
  if (copy.kind === "suspended" && copy.nestedSignalWaits !== undefined) {
    const waits = Array.isArray(copy.nestedSignalWaits)
      ? await readableNestedRuns(
        copy.nestedSignalWaits.filter(isNamedWorkflow),
        (w) => w.workflowId,
        canRead,
      )
      : undefined;
    if (waits) copy.nestedSignalWaits = waits;
    else delete copy.nestedSignalWaits;
  }
  return copy;
}

interface NestedRunEntry {
  workflowId: string;
  workflowName: string;
}

function isNamedWorkflow(value: unknown): value is NamedWorkflow {
  return typeof value === "object" && value !== null &&
    typeof (value as NamedWorkflow).workflowId === "string" &&
    typeof (value as NamedWorkflow).workflowName === "string";
}

function isRunView(value: unknown): value is WorkflowRunView {
  return typeof value === "object" && value !== null &&
    Array.isArray((value as { jobs?: unknown }).jobs);
}

export async function nestedGateRefusalForClient(
  error: SwampError,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<string | undefined> {
  const gate = nestedWaitGateOf(error);
  if (gate) return await canRead(gate) ? error.message : gate.genericMessage;
  // a nested run that was not continued names the run above it only to a reader
  // of that run's workflow
  const orphan = orphanedNestedRunOf(error);
  if (!orphan) return undefined;
  if (
    orphan.parentWorkflowId === undefined ||
    orphan.parentWorkflowName === undefined
  ) {
    return orphan.genericMessage;
  }
  return await canRead({
      workflowId: orphan.parentWorkflowId,
      workflowName: orphan.parentWorkflowName,
    })
    ? error.message
    : orphan.genericMessage;
}

/** without a decider it names no parent */
export async function orphanedRefusalForClient(
  error: OrphanedNestedRunError,
  canRead: ((workflow: NamedWorkflow) => Promise<boolean>) | undefined,
): Promise<string> {
  const parent = error.refusal.parent;
  if (!canRead || !parent) return error.genericMessage;
  return await canRead({
      workflowId: parent.workflowId,
      workflowName: parent.workflowName,
    })
    ? error.message
    : error.genericMessage;
}

export async function readableNestedCascade(
  nested: Partial<NestedCascadeResult>,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<Partial<NestedCascadeResult>> {
  const cancelled = await readableNestedRuns(
    nested.cancelledNestedRuns,
    (d) => d.workflowId,
    canRead,
  );
  const stopping = await readableNestedRuns(
    nested.stopRequestedNestedRuns,
    (d) => d.workflowId,
    canRead,
  );
  const detached = await readableNestedRuns(
    nested.detachedNestedRuns,
    (d) => d.workflowId,
    canRead,
  );
  return {
    ...(cancelled ? { cancelledNestedRuns: cancelled } : {}),
    ...(stopping ? { stopRequestedNestedRuns: stopping } : {}),
    ...(detached ? { detachedNestedRuns: detached } : {}),
  };
}

/**
 * names the runs only when the principal may read every run named: each direct
 * child and the innermost run that has to act, which can be a grandchild in
 * another workflow; without a decider it names none
 */
export async function nestedPendingRefusalForClient(
  error: NestedRunPendingError | NestedRunUnreadableError,
  canRead: ((workflow: NamedWorkflow) => Promise<boolean>) | undefined,
): Promise<string> {
  if (!canRead) return error.genericMessage;
  if (error instanceof NestedRunUnreadableError) {
    const readable = await canRead({
      workflowId: error.child.workflowId,
      workflowName: error.child.workflowName,
    });
    return readable ? error.message : error.genericMessage;
  }
  for (const pending of error.pending) {
    for (const named of [pending.child, pending.action.target]) {
      const readable = await canRead({
        workflowId: named.workflowId,
        workflowName: named.workflowName,
      });
      if (!readable) return error.genericMessage;
    }
  }
  return error.message;
}

export function redactingFor(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
): ((event: SerializedEvent) => Promise<SerializedEvent>) | undefined {
  if (ctx.authConfig.mode === "none") return undefined;
  const canRead = nestedRunReadDecider(ctx, socket, principal);
  return (event) => redactStreamEvent(event, canRead);
}
