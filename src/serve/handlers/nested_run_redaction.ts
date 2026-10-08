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
import type { NestedRunPendingError } from "../../domain/workflows/nested_run_link.ts";
import { nestedWaitGateOf } from "../../libswamp/workflows/nested_runs.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import type { SerializedEvent } from "../protocol.ts";
import { canonicalResources } from "./resource_resolution.ts";
import { type ConnectionContext, resourceDecider } from "./shared.ts";

/** A workflow a nested-run field names. */
export interface NamedWorkflow {
  workflowId: string;
  workflowName: string;
}

/**
 * Decides, silently and per request, whether the principal may read a
 * workflow that a nested-run field names (swamp-club#2736). The fields that
 * link a run to its parent or to the nested runs it waits on are returned
 * only when this allows the workflow they name; the run's own row is
 * authorized as before. Child identity that a run already carried (a
 * succeeded nested step's output, forwarded child events) is unchanged.
 */
export function nestedRunReadDecider(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
): (workflow: NamedWorkflow) => Promise<boolean> {
  if (ctx.authConfig.mode === "none") return () => Promise.resolve(true);
  const canonical = canonicalResources(ctx);
  const allows = resourceDecider(socket, principal, "read", ctx);
  const decided = new Map<string, Promise<boolean>>();
  return (workflow) => {
    const key = JSON.stringify([workflow.workflowId, workflow.workflowName]);
    let found = decided.get(key);
    if (!found) {
      found = canonical.workflowOwners(
        workflow.workflowId,
        workflow.workflowName,
      ).then((resources) => resources.length > 0 && resources.every(allows))
        .catch(() => false);
      decided.set(key, found);
    }
    return found;
  };
}

/**
 * Removes the parent link from a row whose parent workflow the principal
 * may not read, together with anything derived from it.
 */
export async function redactParentRun<
  T extends { parentRun?: NamedWorkflow; parentWaiting?: boolean },
>(
  row: T,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<void> {
  if (row.parentRun && !(await canRead(row.parentRun))) {
    delete row.parentRun;
    delete row.parentWaiting;
  }
}

/** Keeps only the nested runs whose workflow the principal may read. */
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
 * What a step whose nested run is hidden reports instead of its own error,
 * which names that run.
 */
const HIDDEN_NESTED_STEP_ERROR =
  "The step's nested workflow run is not shown: you may not read its workflow.";

/**
 * Removes, from a run view sent to a client, the links to other runs whose
 * workflow the principal may not read (swamp-club#2736): the parent link,
 * the nested runs it waits on and each step's nested run link, with the
 * step's error, which names that run.
 */
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
 * A run stream event as one client may see it: the links to other runs
 * whose workflow the principal may not read are removed, as from a run view
 * (swamp-club#2736), and a nested workflow step's failure that names a
 * hidden nested run reports {@link HIDDEN_NESTED_STEP_ERROR} instead. A
 * suspension names a nested run's open wait for a signal only to a reader of
 * the wait's workflow. A buffered event is shared by every client attached
 * to the run, so an event that needs a change is copied first. A nested run's own events, forwarded
 * into its parent's stream, are left as they are.
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
  if (event.kind === "step_failed" && isNamedWorkflow(event.nestedRun)) {
    if (await canRead(event.nestedRun)) return event;
    const { nestedRun: _hidden, ...rest } = event;
    return { ...rest, error: HIDDEN_NESTED_STEP_ERROR };
  }
  if (!isRunView(event.run)) return event;
  const copy = structuredClone(event) as SerializedEvent & {
    run: WorkflowRunView;
  };
  await redactRunViewLinks(copy.run, canRead);
  // A suspension on a nested run names it beside the step that waits on
  // it, and goes when that step's link went.
  if (copy.kind === "suspended" && copy.nested !== undefined) {
    const step = copy.run.jobs.find((j) => j.name === copy.jobId)?.steps
      .find((s) => s.name === copy.stepId);
    if (!step?.nestedRun) delete copy.nested;
  }
  // A nested run's open wait is named only to a reader of the workflow the
  // wait belongs to, which can be a grandchild's, in another workflow than
  // the run the step waits on (swamp-club#3110).
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

/**
 * The refusal to approve or reject a nested workflow step, naming the
 * nested run only to a reader of its workflow; `undefined` for any other
 * error.
 */
export async function nestedGateRefusalForClient(
  error: SwampError,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<string | undefined> {
  const gate = nestedWaitGateOf(error);
  if (!gate) return undefined;
  return await canRead(gate) ? error.message : gate.genericMessage;
}

/**
 * The refusal to resume a run that waits on unfinished nested runs, naming
 * them only when the principal may read every run it names: each direct
 * child, and the innermost run that has to act, which can be a grandchild
 * in another workflow. Without a decider it names none.
 */
export async function nestedPendingRefusalForClient(
  error: NestedRunPendingError,
  canRead: ((workflow: NamedWorkflow) => Promise<boolean>) | undefined,
): Promise<string> {
  if (!canRead) return error.genericMessage;
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

/**
 * The per-client transform for a run stream: each event as
 * {@link redactStreamEvent} leaves it for this principal. Without auth every
 * workflow is readable and events pass unchanged.
 */
export function redactingFor(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
): ((event: SerializedEvent) => Promise<SerializedEvent>) | undefined {
  if (ctx.authConfig.mode === "none") return undefined;
  const canRead = nestedRunReadDecider(ctx, socket, principal);
  return (event) => redactStreamEvent(event, canRead);
}
