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
import {
  evaluateApprovalTimeout,
  gateTimeoutSeconds,
} from "./approval_timeout.ts";
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
import type {
  NestedWaitRef,
  SignalWaitRef,
  WorkflowRun,
} from "./workflow_run.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["workflow", "nested-run"]);

export interface NestedRunLinkDeps {
  runRepo: Pick<WorkflowRunRepository, "findById" | "recordsAreForwarded">;
  workflowRepo: Pick<WorkflowRepository, "findById">;
  /**
   * with it a child's wait is asked of its outcome; without it, of the child's
   * run record, which still shows a settled wait as open until the child is
   * resumed
   */
  signalWaits?: SignalWaitSupport;
}

export type ChildResolution =
  | {
    readonly kind: "resolved";
    readonly child: WorkflowRun;
    readonly backLinkDropped?: true;
  }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "broken"; readonly reason: string }
  | {
    readonly kind: "unreadable";
    readonly ref: NestedRunRef;
    readonly reason: string;
  };

export interface NestedRunTarget {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
  readonly serveOwned: boolean;
}

export type NestedWaitAction =
  | {
    readonly kind: "approve";
    readonly target: NestedRunTarget;
    readonly jobName: string;
    readonly stepName: string;
  }
  | {
    readonly kind: "signal";
    readonly target: NestedRunTarget;
    readonly jobName: string;
    readonly stepName: string;
    readonly waitId: string;
    readonly deadline: string;
    readonly key?: string;
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
    readonly kind: "running";
    readonly target: NestedRunTarget;
  };

export interface PendingNestedWait {
  readonly wait: NestedWaitRef;
  readonly child: WorkflowRun;
  readonly action: NestedWaitAction;
}

export interface AncestorRunRef {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
}

export type ParentVerdict =
  | { readonly kind: "none" }
  | {
    readonly kind: "awaited";
    readonly ancestors: readonly AncestorRunRef[];
  }
  | {
    readonly kind: "ended";
    readonly parent: AncestorRunRef;
    readonly status: string;
  }
  | { readonly kind: "replaced"; readonly parent: AncestorRunRef }
  | {
    readonly kind: "unreadable";
    readonly reason: string;
    readonly parent?: AncestorRunRef;
    readonly missing?: true;
  };

export function isOrphaned(
  verdict: ParentVerdict,
): verdict is Extract<ParentVerdict, { kind: "ended" | "replaced" }> {
  return verdict.kind === "ended" || verdict.kind === "replaced";
}

const FINISHED = new Set(["succeeded", "failed", "cancelled"]);

export function isFinishedRun(run: WorkflowRun): boolean {
  return FINISHED.has(run.status);
}

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

export class NestedRunLink {
  constructor(private readonly deps: NestedRunLinkDeps) {}

  /**
   * an older binary drops parentRun when it saves the child, so a child with
   * none is accepted if the fields such a save keeps agree with the parent; a
   * malformed or mismatched parentRun never is
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
      this.deps.runRepo.recordsAreForwarded !== true &&
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

  async childrenSettled(parent: WorkflowRun): Promise<boolean> {
    return (await this.pendingWaits(parent)).length === 0;
  }

  /**
   * ending parent discards a wait below it as surely as ending the run that
   * holds it; only a child linked both ways is followed
   */
  async signalWaitsBelow(
    parent: WorkflowRun,
    depth = 1,
  ): Promise<SignalWaitRef[]> {
    if (depth > MAX_WORKFLOW_NESTING_DEPTH) return [];
    const waits: SignalWaitRef[] = [];
    for (const wait of parent.findNestedWaits()) {
      // A child that cannot be read is passed over, as one that does not
      // link back is: nothing cancels it with `parent` either.
      const resolved = await this.resolveChild(parent, wait).catch(() =>
        undefined
      );
      if (resolved?.kind !== "resolved" || isFinishedRun(resolved.child)) {
        continue;
      }
      for (const held of resolved.child.findSignalWaits()) waits.push(held);
      for (
        const below of await this.signalWaitsBelow(resolved.child, depth + 1)
      ) {
        waits.push(below);
      }
    }
    return waits;
  }

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
   * a parent records its wait only once its child has suspended, so an
   * unfinished parent whose step carries no link yet still awaits a child that
   * started no earlier than that step
   */
  async parentVerdict(run: WorkflowRun): Promise<ParentVerdict> {
    if (run.parentRun === undefined) return { kind: "none" };
    const ancestors: AncestorRunRef[] = [];
    let current = run;
    for (let depth = 0; depth < MAX_WORKFLOW_NESTING_DEPTH; depth++) {
      const link = current.parentRun;
      if (link === undefined) break;
      if (link.kind !== "valid") {
        return {
          kind: "unreadable",
          reason: `run ${current.id} has a malformed parent run link`,
        };
      }
      const ref = link.ref;
      const ancestor: AncestorRunRef = {
        workflowId: ref.workflowId,
        workflowName: ref.workflowName,
        runId: ref.runId,
      };
      let parent: WorkflowRun | null;
      try {
        parent = await this.deps.runRepo.findById(
          createWorkflowId(ref.workflowId),
          createWorkflowRunId(ref.runId),
        );
      } catch {
        return {
          kind: "unreadable",
          reason: `parent run ${ref.runId} could not be read`,
          parent: ancestor,
        };
      }
      if (!parent) {
        return {
          kind: "unreadable",
          reason: `parent run ${ref.runId} no longer exists`,
          parent: ancestor,
          missing: true,
        };
      }
      if (isFinishedRun(parent)) {
        return { kind: "ended", parent: ancestor, status: parent.status };
      }
      const step = parent.getJob(ref.jobName)?.getStep(ref.stepName);
      if (!step) {
        return {
          kind: "unreadable",
          reason:
            `parent run ${ref.runId} has no step "${ref.stepName}" in job "${ref.jobName}"`,
          parent: ancestor,
        };
      }
      const forward = step.nestedRun;
      // A link that cannot be read says nothing about which run the step
      // waits on, so it is never taken for the step having moved on.
      if (forward !== undefined && forward.kind !== "valid") {
        return {
          kind: "unreadable",
          reason:
            `step "${ref.stepName}" of parent run ${ref.runId} has a malformed nested run link`,
          parent: ancestor,
        };
      }
      const movedOn = forward !== undefined
        ? !sameRunId(forward.ref.runId, current.id)
        : step.startedAt === undefined ||
          (current.startedAt !== undefined &&
            current.startedAt.getTime() < step.startedAt.getTime());
      if (movedOn) return { kind: "replaced", parent: ancestor };
      ancestors.push(ancestor);
      current = parent;
    }
    return { kind: "awaited", ancestors };
  }

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
      const timeout = evaluateApprovalTimeout(
        step?.startedAt,
        gateTimeoutSeconds(
          step,
          workflow?.jobs.find((j) => j.name === gate.jobName)?.steps,
        ),
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
        ...(openWait.wait.key !== undefined ? { key: openWait.wait.key } : {}),
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

function openWaitOnRecord(
  run: WorkflowRun,
  now: Date,
): OpenWaitRef | undefined {
  const open = run.findOpenSignalWait(now);
  if (!open) return undefined;
  return {
    jobName: open.jobName,
    stepName: open.stepName,
    wait: {
      id: open.wait.id,
      deadline: open.wait.deadline.toISOString(),
      ...(open.wait.key !== undefined ? { key: open.wait.key } : {}),
    },
  };
}

function server(target: NestedRunTarget): string {
  return target.serveOwned ? " --server <url>" : "";
}

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

  get genericMessage(): string {
    return `Run ${this.parent.id} waits on a nested workflow run that has not finished. ` +
      `Finish or cancel the nested run, then resume this run.`;
  }
}

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

  get genericMessage(): string {
    return `Run ${this.parent.id} waits on a nested workflow run whose record cannot be read. ` +
      `Repair that run's record, then resume this run, or cancel this run.`;
  }
}

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
