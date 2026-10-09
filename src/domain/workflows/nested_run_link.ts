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

import type { SignalWaitSupport } from "./signal_wait_store.ts";
import { findUnsettledWait, type OpenWaitRef } from "./signal_wait_cleanup.ts";
import { UserError } from "../errors.ts";
import { evaluateApprovalTimeout } from "./approval_timeout.ts";
import {
  MAX_WORKFLOW_NESTING_DEPTH,
  type NestedRunRef,
  sameRunId,
} from "./nested_run_ref.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "./repositories.ts";
import { createWorkflowId, createWorkflowRunId } from "./workflow_id.ts";
import type { NestedWaitRef, WorkflowRun } from "./workflow_run.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["workflow", "nested-run"]);

/** What NestedRunLink reads. It never writes. */
export interface NestedRunLinkDeps {
  runRepo: Pick<WorkflowRunRepository, "findById">;
  workflowRepo: Pick<WorkflowRepository, "findById">;
  /**
   * Where signal wait records are kept. With it a child's wait is asked of
   * its outcome; without it, of the child's run record, which still shows
   * a wait a signal has settled as open until the child is resumed.
   */
  signalWaits?: SignalWaitSupport;
}

/**
 * A child run as a parent's nested wait resolves it. `backLinkDropped` is set
 * when the child carries no parentRun at all and was accepted on the record
 * fields an older binary keeps when it saves the run (see
 * {@link NestedRunLink.resolveChild}).
 */
export type ChildResolution =
  | {
    readonly kind: "resolved";
    readonly child: WorkflowRun;
    readonly backLinkDropped?: true;
  }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "broken"; readonly reason: string }
  | {
    /** The child's record exists, or may, but reading it failed. */
    readonly kind: "unreadable";
    readonly ref: NestedRunRef;
    readonly reason: string;
  };

/** The run a next action names. */
export interface NestedRunTarget {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
  /** True when a serve instance owns the run, so commands need --server. */
  readonly serveOwned: boolean;
}

/**
 * What it takes for a parent's nested wait to settle, at the innermost run
 * that has to act.
 */
export type NestedWaitAction =
  | {
    readonly kind: "approve";
    readonly target: NestedRunTarget;
    readonly jobName: string;
    readonly stepName: string;
  }
  | {
    /** A step of the run waits for a signal on a wait still open. */
    readonly kind: "signal";
    readonly target: NestedRunTarget;
    readonly jobName: string;
    readonly stepName: string;
    readonly waitId: string;
    /** When the wait stops accepting a signal, as an ISO timestamp. */
    readonly deadline: string;
  }
  | { readonly kind: "resume"; readonly target: NestedRunTarget }
  | { readonly kind: "recover"; readonly target: NestedRunTarget }
  | {
    readonly kind: "cancel";
    readonly target: NestedRunTarget;
    readonly reason: "expired_gate";
    readonly stepName: string;
  }
  | {
    /**
     * The run is running or pending: wait for it, or cancel it if no process
     * drives it any more.
     */
    readonly kind: "running";
    readonly target: NestedRunTarget;
  };

/** A nested wait whose child has not finished. */
export interface PendingNestedWait {
  readonly wait: NestedWaitRef;
  readonly child: WorkflowRun;
  readonly action: NestedWaitAction;
}

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

/** True when a run has finished: succeeded, failed or cancelled. */
export function isFinishedRun(run: WorkflowRun): boolean {
  return FINISHED.has(run.status);
}

/**
 * True when a child with no parentRun agrees with the step waiting on it on
 * every field an older binary keeps when it saves the child: a nested run
 * has no trigger source of its own, inherits its parent's initiator, and
 * starts once the step that runs it has started.
 */
function startedByWaitingStep(
  parent: WorkflowRun,
  wait: NestedWaitRef,
  child: WorkflowRun,
): boolean {
  const stepStartedAt = parent.getJob(wait.jobName)?.getStep(wait.stepName)
    ?.startedAt;
  const childStartedAt = child.startedAt;
  return child.triggerSource === undefined &&
    child.initiatedBy === parent.initiatedBy &&
    stepStartedAt !== undefined && childStartedAt !== undefined &&
    childStartedAt.getTime() >= stepStartedAt.getTime();
}

function targetOf(run: WorkflowRun): NestedRunTarget {
  return {
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runId: run.id,
    serveOwned: run.instanceId !== undefined,
  };
}

/**
 * Follows the links between a parent run's nested workflow steps and the
 * child runs they wait on (swamp-club#2736). Every link is validated from
 * both ends before it is followed, and nothing here writes a run: whether a
 * parent can continue is always derived from its children.
 */
export class NestedRunLink {
  constructor(private readonly deps: NestedRunLinkDeps) {}

  /**
   * Loads the child a nested wait links and checks it links back: the
   * child's id and workflow must be the ones linked, and its parentRun must
   * name this parent run and step.
   *
   * An older binary drops parentRun when it saves the child (an approve or
   * resume of the child from a version without nested gates). A child with
   * no parentRun at all is still accepted when the fields such a save keeps
   * agree with this parent: no trigger source of its own, the parent's
   * initiator, and a start no earlier than the waiting step's. A malformed
   * or mismatched parentRun is never accepted.
   *
   * A child whose record cannot be read is reported as unreadable, never
   * thrown: the cause is logged, since a parse error quotes the record.
   */
  async resolveChild(
    parent: WorkflowRun,
    wait: NestedWaitRef,
  ): Promise<ChildResolution> {
    if (wait.link.kind === "broken") {
      return {
        kind: "broken",
        reason: `step "${wait.stepName}" has a malformed nested run link`,
      };
    }
    const ref = wait.link.ref;
    let child: WorkflowRun | null;
    try {
      child = await this.deps.runRepo.findById(
        createWorkflowId(ref.workflowId),
        createWorkflowRunId(ref.runId),
      );
    } catch (error) {
      logger.warn(
        "Could not read the record of nested run {runId} of workflow {workflowName}: {error}",
        {
          runId: ref.runId,
          workflowName: ref.workflowName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        kind: "unreadable",
        ref,
        reason:
          `the record of nested run ${ref.runId} of workflow "${ref.workflowName}" cannot be read`,
      };
    }
    if (!child) {
      return {
        kind: "missing",
        reason:
          `nested run ${ref.runId} of workflow "${ref.workflowName}" no longer exists`,
      };
    }
    const back = child.parentRun;
    const sameChild = sameRunId(child.id, ref.runId) &&
      sameRunId(child.workflowId, ref.workflowId);
    const linksBack = sameChild &&
      back?.kind === "valid" &&
      sameRunId(back.ref.runId, parent.id) &&
      sameRunId(back.ref.workflowId, parent.workflowId) &&
      back.ref.jobName === wait.jobName &&
      back.ref.stepName === wait.stepName;
    if (linksBack) return { kind: "resolved", child };
    if (
      sameChild && back === undefined &&
      startedByWaitingStep(parent, wait, child)
    ) {
      return { kind: "resolved", child, backLinkDropped: true };
    }
    return {
      kind: "broken",
      reason:
        `nested run ${ref.runId} does not link back to step "${wait.stepName}" of run ${parent.id}`,
    };
  }

  /**
   * The parent's nested waits whose child has not finished, each with the
   * action that settles it. A missing child or broken link is not pending:
   * the parent's resume fails that step. A child whose record cannot be read
   * may be either, so it throws {@link NestedRunUnreadableError}.
   */
  async pendingWaits(parent: WorkflowRun): Promise<PendingNestedWait[]> {
    const pending: PendingNestedWait[] = [];
    for (const wait of parent.findNestedWaits()) {
      const resolved = await this.resolveChild(parent, wait);
      if (resolved.kind === "unreadable") {
        throw new NestedRunUnreadableError(
          { workflowName: parent.workflowName, id: parent.id },
          resolved.ref,
        );
      }
      if (resolved.kind !== "resolved" || isFinishedRun(resolved.child)) {
        continue;
      }
      pending.push({
        wait,
        child: resolved.child,
        action: await this.describeWait(resolved.child, 1),
      });
    }
    return pending;
  }

  /**
   * True when every nested wait of the parent has a finished child. Throws
   * {@link NestedRunUnreadableError} when a child's record cannot be read.
   */
  async childrenSettled(parent: WorkflowRun): Promise<boolean> {
    return (await this.pendingWaits(parent)).length === 0;
  }

  /**
   * True while the child's parent run exists, has not finished, and a step
   * of it still waits on this exact child.
   */
  async isAwaitedByParent(child: WorkflowRun): Promise<boolean> {
    const link = child.parentRun;
    if (link?.kind !== "valid") return false;
    const parent = await this.deps.runRepo.findById(
      createWorkflowId(link.ref.workflowId),
      createWorkflowRunId(link.ref.runId),
    );
    if (!parent || isFinishedRun(parent)) return false;
    const step = parent.getJob(link.ref.jobName)?.getStep(link.ref.stepName);
    return step?.isNestedWait === true && step.nestedRun?.kind === "valid" &&
      sameRunId(step.nestedRun.ref.runId, child.id);
  }

  /**
   * The action that moves an unfinished child run on, walking down to the
   * innermost run that has to act.
   */
  async describeWait(
    child: WorkflowRun,
    depth: number,
  ): Promise<NestedWaitAction> {
    const target = targetOf(child);
    if (child.status === "interrupted") return { kind: "recover", target };
    if (child.status !== "suspended") return { kind: "running", target };

    const gate = child.findWaitingApprovalStep();
    if (gate) {
      const step = child.getJob(gate.jobName)?.getStep(gate.stepName);
      const workflow = await this.deps.workflowRepo.findById(
        createWorkflowId(child.workflowId),
      );
      const taskData = workflow?.jobs.find((j) => j.name === gate.jobName)
        ?.steps.find((s) => s.name === gate.stepName)?.task.data;
      const timeout = evaluateApprovalTimeout(
        step?.startedAt,
        taskData,
        new Date(),
      );
      if (timeout?.expired) {
        return {
          kind: "cancel",
          target,
          reason: "expired_gate",
          stepName: gate.stepName,
        };
      }
      return {
        kind: "approve",
        target,
        jobName: gate.jobName,
        stepName: gate.stepName,
      };
    }

    // A wait past its deadline is settled by a resume, which fails its step.
    const openWait = this.deps.signalWaits?.supported
      ? await findUnsettledWait(
        this.deps.signalWaits.store,
        child,
        new Date(),
      )
      : openWaitOnRecord(child, new Date());
    if (openWait) {
      return {
        kind: "signal",
        target,
        jobName: openWait.jobName,
        stepName: openWait.stepName,
        waitId: openWait.wait.id,
        deadline: openWait.wait.deadline,
      };
    }

    if (depth < MAX_WORKFLOW_NESTING_DEPTH) {
      for (const wait of child.findNestedWaits()) {
        const resolved = await this.resolveChild(child, wait);
        if (
          resolved.kind === "resolved" && !isFinishedRun(resolved.child)
        ) {
          return await this.describeWait(resolved.child, depth + 1);
        }
      }
    }
    return { kind: "resume", target };
  }
}

/** The run's first open wait as its own record shows it, with no store. */
function openWaitOnRecord(
  run: WorkflowRun,
  now: Date,
): OpenWaitRef | undefined {
  const open = run.findOpenSignalWait(now);
  if (!open) return undefined;
  return {
    jobName: open.jobName,
    stepName: open.stepName,
    wait: { id: open.wait.id, deadline: open.wait.deadline.toISOString() },
  };
}

function server(target: NestedRunTarget): string {
  return target.serveOwned ? " --server <url>" : "";
}

/**
 * The commands that settle a nested wait, as one sentence for a refusal or
 * a hint. A serve-owned run gets the --server form.
 */
export function nestedWaitHint(action: NestedWaitAction): string {
  const t = action.target;
  const run = `run ${t.runId} of workflow "${t.workflowName}"`;
  switch (action.kind) {
    case "approve":
      return `Nested ${run} awaits approval on step "${action.stepName}": ` +
        `'swamp workflow approve ${t.workflowName} ${action.stepName} --run ${t.runId}${
          server(t)
        }', then 'swamp workflow resume ${t.workflowName} --run ${t.runId}${
          server(t)
        }'.`;
    case "signal":
      return `Nested ${run} waits for a signal on step "${action.stepName}": ` +
        `swamp workflow signal ${action.waitId} --payload '<json>'${
          server(t)
        }, then 'swamp workflow resume ${t.workflowName} --run ${t.runId}${
          server(t)
        }'.`;
    case "resume":
      return `Nested ${run} is ready to resume: 'swamp workflow resume ${t.workflowName} --run ${t.runId}${
        server(t)
      }'.`;
    case "recover":
      // recover has no --server form: it rewrites the run file in place, so
      // a serve-owned child is recovered from the server's repository.
      return `Nested ${run} was interrupted: 'swamp workflow recover ${t.workflowName} --run ${t.runId}'${
        t.serveOwned ? ", run in the server's repository" : ""
      }.`;
    case "cancel":
      return `Nested ${run} can no longer be approved: the approval on step "${action.stepName}" timed out. ` +
        `Cancel it with 'swamp workflow cancel ${t.workflowName} --run ${t.runId}${
          server(t)
        }'.`;
    case "running":
      return `Nested ${run} is still running. Wait for it to finish, or cancel it if nothing drives it any more: ` +
        `'swamp workflow cancel ${t.workflowName} --run ${t.runId}${
          server(t)
        }'.`;
  }
}

/**
 * Refuses a resume of a run whose nested workflow steps wait on child runs
 * that have not finished. The message names each child and what settles
 * it; {@link genericMessage} names none, for callers that may not reveal
 * the child runs.
 */
export class NestedRunPendingError extends UserError {
  constructor(
    readonly parent: { readonly workflowName: string; readonly id: string },
    readonly pending: readonly PendingNestedWait[],
  ) {
    super(
      `Run ${parent.id} of workflow "${parent.workflowName}" waits on ${
        pending.length === 1
          ? "a nested workflow run that has"
          : `${pending.length} nested workflow runs that have`
      } not finished. ` +
        pending.map((p) => nestedWaitHint(p.action)).join(" ") +
        ` Then resume this run with 'swamp workflow resume ${parent.workflowName} --run ${parent.id}'.`,
    );
    this.name = "NestedRunPendingError";
  }

  /** The refusal without naming any child run. */
  get genericMessage(): string {
    return `Run ${this.parent.id} waits on a nested workflow run that has not finished. ` +
      `Finish or cancel the nested run, then resume this run.`;
  }
}

/**
 * Refuses a resume of a run whose nested workflow step waits on a child run
 * whose record cannot be read, so whether the child finished is unknown.
 * The message names the child; {@link genericMessage} does not, for callers
 * that may not reveal the child runs.
 */
export class NestedRunUnreadableError extends UserError {
  constructor(
    readonly parent: { readonly workflowName: string; readonly id: string },
    readonly child: NestedRunRef,
  ) {
    super(
      `Run ${parent.id} of workflow "${parent.workflowName}" waits on nested run ${child.runId} of workflow "${child.workflowName}", whose record cannot be read. ` +
        `Repair that run's record, then resume this run with 'swamp workflow resume ${parent.workflowName} --run ${parent.id}', ` +
        `or cancel this run with 'swamp workflow cancel ${parent.workflowName} --run ${parent.id}'.`,
    );
    this.name = "NestedRunUnreadableError";
  }

  /** The refusal without naming the child run. */
  get genericMessage(): string {
    return `Run ${this.parent.id} waits on a nested workflow run whose record cannot be read. ` +
      `Repair that run's record, then resume this run, or cancel this run.`;
  }
}

/**
 * Refuses, changing nothing, while a nested workflow step of the run waits
 * on a child run that has not finished, or whose record cannot be read.
 * Every resume entry reaches this before the run is changed.
 */
export async function assertNestedWaitsSettled(
  deps: NestedRunLinkDeps,
  run: WorkflowRun,
): Promise<void> {
  if (run.findNestedWaits().length === 0) return;
  const pending = await new NestedRunLink(deps).pendingWaits(run);
  if (pending.length > 0) {
    throw new NestedRunPendingError(
      { workflowName: run.workflowName, id: run.id },
      pending,
    );
  }
}
