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

import {
  type FanOutGateKind,
  type FanOutPolicy,
  hasLane,
} from "../remote/fan_out.ts";
import { evaluateApprovalTimeout } from "./approval_timeout.ts";
import { fanOutGates } from "./fan_out_gates.ts";
import { laneFailed, laneRecords } from "./fan_out_lanes.ts";
import type { JobRunData, StepRunData } from "./workflow_run.ts";

export type FanOutLaneResult =
  | "succeeded"
  | "failed"
  | "held"
  | "running"
  | "unknown"
  | "not_run";

export interface FanOutMemberView {
  worker: string;
  disposition: string;
  reason?: string;
  batch?: number;
  /** only a member with a lane (dispatch or waiting) has one */
  lane?: FanOutLaneResult;
  /** steps that failed without allowFailure, with their errors */
  failedSteps?: { step: string; error?: string }[];
  /** assertions that did not pass, of any severity */
  assertions?: { step: string; severity: string; message: string }[];
}

export type FanOutHaltView =
  | {
    reason: "budget";
    /** index into batches */
    batch: number;
    maxFailures: number;
    /** lanes that failed in the halted attempt */
    failed: string[];
    held: string[];
  }
  | { reason: "gate_rejected"; gate: FanOutGateKind; held: string[] };

export type FanOutGateStatus =
  | "pending"
  | "waiting"
  | "expired"
  | "approved"
  | "rejected"
  | "held"
  | "failed";

export interface FanOutGateView {
  kind: FanOutGateKind;
  step: string;
  status: FanOutGateStatus;
  /** set on an expired gate: when its approveTimeout ran out */
  expiredAt?: string;
}

/** what the record shows of the latest resume; earlier ones are not recorded */
export interface FanOutResumeView {
  at: string;
  rerun: string[];
  kept: string[];
}

/** built from the run record on every read, never stored */
export interface FanOutJobView {
  selector: { labels?: Record<string, string>; platform?: string };
  /** from the run's evaluated workflow; absent when that is gone */
  policy?: { offline: string; minWorkers: number };
  plannedLanes: number;
  batches: string[][];
  /** used counts only lanes failing now; each halt keeps its own attempt's failures */
  budget: { allowed: number | null; used: number };
  members: FanOutMemberView[];
  /** one per halted attempt, in order, then a gate rejection, which is final */
  halts: FanOutHaltView[];
  gates: FanOutGateView[];
  resume?: FanOutResumeView;
}

export interface FanOutViewOptions {
  resumedAt?: string;
  policy?: Pick<FanOutPolicy, "offline" | "minWorkers">;
  mask?: (text: string) => string;
  now?: Date;
}

type FanOutJob = Pick<
  JobRunData,
  "jobName" | "steps" | "fanOutPlan" | "fanOutSnapshot" | "fanOutHalts"
>;

const UNFINISHED = new Set([
  "pending",
  "running",
  "waiting",
  "waiting_approval",
  "waiting_signal",
]);

function heldUnstarted(steps: readonly StepRunData[]): boolean {
  return steps.length > 0 &&
    steps.every((step) =>
      step.status === "skipped" && step.skipReason?.kind === "job_skipped" &&
      step.startedAt === undefined
    );
}

function laneOutcome(
  steps: readonly StepRunData[],
  held: boolean,
): FanOutLaneResult {
  if (held) return "held";
  const failed = laneFailed(steps.map((step) => ({
    status: step.status,
    allowedFailure: step.allowedFailure ?? false,
  })));
  if (failed) return "failed";
  if (steps.some((step) => step.status === "unknown")) return "unknown";
  if (heldUnstarted(steps)) return "not_run";
  // a lane that never ran must not read as passed
  const ran = steps.some((step) =>
    step.status !== "pending" && !step.settledByAbort
  );
  if (!ran) return "not_run";
  return steps.some((step) => UNFINISHED.has(step.status))
    ? "running"
    : "succeeded";
}

function gateStatus(
  step: StepRunData,
  now: Date,
): Pick<FanOutGateView, "status" | "expiredAt"> {
  switch (step.status) {
    case "pending":
      return { status: "pending" };
    case "skipped":
      return { status: "held" };
    case "waiting_approval": {
      const started = step.startedAt ? new Date(step.startedAt) : undefined;
      const timeout = evaluateApprovalTimeout(
        started,
        step.approvalTimeout,
        now,
      );
      return timeout?.expired && started
        ? {
          status: "expired",
          expiredAt: new Date(
            started.getTime() + timeout.timeoutSeconds * 1000,
          ).toISOString(),
        }
        : { status: "waiting" };
    }
    case "succeeded":
      return { status: "approved" };
    case "failed":
      return step.approvalDecision?.approved === false
        ? { status: "rejected" }
        : { status: "failed" };
    default:
      return { status: "waiting" };
  }
}

/** step errors and assertion messages are the run's text, masked as its view is */
export function fanOutJobView(
  job: FanOutJob,
  options: FanOutViewOptions = {},
): FanOutJobView | undefined {
  const plan = job.fanOutPlan;
  if (plan === undefined) return undefined;
  const mask = options.mask ?? ((text: string) => text);
  const now = options.now ?? new Date();
  const records = laneRecords(job.steps, plan.lanes);
  const halts = job.fanOutHalts ?? [];

  const gates: FanOutGateView[] = [...fanOutGates(job)].map((
    [kind, step],
  ) => ({ kind, step: step.stepName, ...gateStatus(step, now) }));
  const rejected = gates.find((gate) => gate.status === "rejected");

  // job_skipped also settles a cancelled lane, so only a halt that named the
  // lane, or a rejected gate, makes it held
  const heldByHalt = new Set(halts.flatMap((halt) => halt.held));
  const isHeld = (worker: string) => {
    const steps = records.get(worker) ?? [];
    return heldUnstarted(steps) &&
      (heldByHalt.has(worker) || rejected !== undefined);
  };

  const members: FanOutMemberView[] = plan.members.map((member) => {
    const view: FanOutMemberView = {
      worker: member.worker,
      disposition: member.disposition,
      ...(member.reason !== undefined ? { reason: member.reason } : {}),
      ...(member.batch !== undefined ? { batch: member.batch } : {}),
    };
    if (!hasLane(member)) return view;
    const steps = records.get(member.worker) ?? [];
    view.lane = laneOutcome(steps, isHeld(member.worker));
    const failedSteps = steps.filter((step) =>
      step.status === "failed" && !step.allowedFailure
    ).map((step) => ({
      step: step.stepName,
      ...(step.error !== undefined ? { error: mask(step.error) } : {}),
    }));
    const assertions = steps.flatMap((step) =>
      step.assertResult !== undefined && !step.assertResult.passed
        ? [{
          step: step.stepName,
          severity: step.assertResult.severity,
          message: mask(step.assertResult.message),
        }]
        : []
    );
    if (failedSteps.length > 0) view.failedSteps = failedSteps;
    if (assertions.length > 0) view.assertions = assertions;
    return view;
  });

  const haltViews: FanOutHaltView[] = halts.map((halt) => ({
    reason: "budget",
    batch: halt.batch,
    maxFailures: halt.maxFailures,
    failed: [...halt.failed],
    held: [...halt.held],
  }));
  if (rejected !== undefined) {
    haltViews.push({
      reason: "gate_rejected",
      gate: rejected.kind,
      held: plan.batches.flat().filter(isHeld),
    });
  }

  const lanes = plan.batches.flat().filter((worker) => records.has(worker));
  const used =
    lanes.filter((worker) =>
      members.find((member) => member.worker === worker)?.lane === "failed"
    ).length;

  const selector = job.fanOutSnapshot?.selector ?? {};
  const view: FanOutJobView = {
    selector: {
      ...(selector.labels !== undefined
        ? { labels: { ...selector.labels } }
        : {}),
      ...(selector.platform !== undefined
        ? { platform: selector.platform }
        : {}),
    },
    ...(options.policy !== undefined
      ? {
        policy: {
          offline: options.policy.offline,
          minWorkers: options.policy.minWorkers,
        },
      }
      : {}),
    plannedLanes: plan.plannedLanes,
    batches: plan.batches.map((batch) => [...batch]),
    budget: { allowed: plan.maxFailures, used },
    members,
    halts: haltViews,
    gates,
  };

  if (options.resumedAt !== undefined) {
    const at = options.resumedAt;
    const resumedMs = new Date(at).getTime();
    const rerun: string[] = [];
    const kept: string[] = [];
    for (const worker of lanes) {
      const steps = records.get(worker) ?? [];
      const startedSince = steps.some((step) =>
        step.startedAt !== undefined &&
        new Date(step.startedAt).getTime() >= resumedMs
      );
      // a reset lane has no start before the resume: pending, or held again
      const settledBefore = steps.length > 0 &&
        steps.every((step) => !UNFINISHED.has(step.status)) &&
        !heldUnstarted(steps);
      (startedSince || !settledBefore ? rerun : kept).push(worker);
    }
    view.resume = { at, rerun, kept };
  }
  return view;
}
