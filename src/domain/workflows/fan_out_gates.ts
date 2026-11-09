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
  FAN_OUT_GATE_KINDS,
  type FanOutGateKind,
  fanOutGateName,
  fanOutGateOf,
} from "../remote/fan_out.ts";
import { laneFailed, laneRecords } from "./fan_out_lanes.ts";
import type { JobRunData, StepRunData } from "./workflow_run.ts";

export interface FanOutGateMember {
  readonly worker: string;
  readonly disposition: string;
  readonly reason?: string;
  readonly batch?: number;
}

export interface FanOutCanaryLane {
  readonly worker: string;
  readonly status: "succeeded" | "failed";
  /** steps that failed without allowFailure, with their errors */
  readonly failedSteps: { readonly step: string; readonly error?: string }[];
  /** assertions that did not pass, of any severity */
  readonly assertions: {
    readonly step: string;
    readonly severity: string;
    readonly message: string;
  }[];
}

/** what the approver decides on; built from the run record, never stored */
export interface FanOutGatePrompt {
  readonly gate: FanOutGateKind;
  readonly job: string;
  readonly selector: {
    readonly labels?: Readonly<Record<string, string>>;
    readonly platform?: string;
  };
  readonly members: FanOutGateMember[];
  readonly batches: string[][];
  /** used is set at the canary gate: failed canary lanes */
  readonly budget: { readonly allowed: number | null; readonly used?: number };
  readonly canary?: { readonly lanes: FanOutCanaryLane[] };
  /** at the canary gate: the lanes the next batch starts */
  readonly next?: string[];
}

export function fanOutGatePromptLine(
  jobName: string,
  gate: FanOutGateKind,
): string {
  return gate === "plan"
    ? `Approve the fan-out plan of job '${jobName}' before any lane starts`
    : `Approve the rest of the rollout of job '${jobName}' after its canary batch`;
}

type GateJob = Pick<JobRunData, "jobName" | "steps" | "fanOutPlan"> & {
  readonly fanOutSnapshot?: JobRunData["fanOutSnapshot"];
};

/** the job's gate records by kind; none for a job without a plan */
export function fanOutGates(
  job: Pick<JobRunData, "jobName" | "steps" | "fanOutPlan">,
): Map<FanOutGateKind, StepRunData> {
  const gates = new Map<FanOutGateKind, StepRunData>();
  if (job.fanOutPlan === undefined) return gates;
  for (const step of job.steps) {
    const kind = fanOutGateOf(job.jobName, step.stepName);
    if (kind !== undefined) gates.set(kind, step);
  }
  return gates;
}

/** the gate records a plan gets; a canary gate needs a batch after the canary */
export function plannedGateNames(
  jobName: string,
  approve: readonly FanOutGateKind[],
  batches: number,
): string[] {
  return FAN_OUT_GATE_KINDS.filter((kind) =>
    approve.includes(kind) && (kind === "plan" || batches > 1)
  ).map((kind) => fanOutGateName(jobName, kind));
}

export function gateApproved(step: StepRunData | undefined): boolean {
  return step?.status === "succeeded" &&
    step.approvalDecision?.approved === true;
}

function laneResult(
  worker: string,
  steps: StepRunData[],
  mask: (text: string) => string,
): FanOutCanaryLane {
  const failed = laneFailed(
    steps.map((step) => ({
      status: step.status,
      allowedFailure: step.allowedFailure ?? false,
    })),
  );
  return {
    worker,
    status: failed ? "failed" : "succeeded",
    failedSteps: steps.filter((step) =>
      step.status === "failed" && !step.allowedFailure
    ).map((step) => ({
      step: step.stepName,
      ...(step.error !== undefined ? { error: mask(step.error) } : {}),
    })),
    assertions: steps.flatMap((step) =>
      step.assertResult !== undefined && !step.assertResult.passed
        ? [{
          step: step.stepName,
          severity: step.assertResult.severity,
          message: mask(step.assertResult.message),
        }]
        : []
    ),
  };
}

/** step errors and assertion messages are the run's text, masked as its prompt is */
export function fanOutGatePrompt(
  job: GateJob,
  gate: FanOutGateKind,
  mask: (text: string) => string = (text) => text,
): FanOutGatePrompt | undefined {
  const plan = job.fanOutPlan;
  if (plan === undefined) return undefined;
  const selector = job.fanOutSnapshot?.selector ?? {};
  const base = {
    gate,
    job: job.jobName,
    selector: {
      ...(selector.labels !== undefined ? { labels: selector.labels } : {}),
      ...(selector.platform !== undefined
        ? { platform: selector.platform }
        : {}),
    },
    members: plan.members.map((member) => ({
      worker: member.worker,
      disposition: member.disposition,
      ...(member.reason !== undefined ? { reason: member.reason } : {}),
      ...(member.batch !== undefined ? { batch: member.batch } : {}),
    })),
    batches: plan.batches.map((batch) => [...batch]),
  };
  if (gate === "plan") {
    return { ...base, budget: { allowed: plan.maxFailures } };
  }
  const records = laneRecords(job.steps, plan.lanes);
  const lanes = (plan.batches[0] ?? []).map((worker) =>
    laneResult(worker, records.get(worker) ?? [], mask)
  );
  return {
    ...base,
    budget: {
      allowed: plan.maxFailures,
      used: lanes.filter((lane) => lane.status === "failed").length,
    },
    canary: { lanes },
    next: [...(plan.batches[1] ?? [])],
  };
}

function selectorText(selector: FanOutGatePrompt["selector"]): string {
  const parts = Object.entries(selector.labels ?? {}).map(([key, value]) =>
    `${key}=${value}`
  );
  if (selector.platform !== undefined) {
    parts.push(`platform=${selector.platform}`);
  }
  return parts.length > 0 ? parts.join(", ") : "(not recorded)";
}

function budgetText(budget: FanOutGatePrompt["budget"]): string {
  const allowed = budget.allowed === null
    ? "no budget"
    : `${budget.allowed} failed lane(s) allowed`;
  return budget.used === undefined
    ? allowed
    : `${budget.used} used, ${allowed}`;
}

/** the prompt as text, for log mode and the approvals list */
export function fanOutGatePromptText(prompt: FanOutGatePrompt): string {
  const lines = [fanOutGatePromptLine(prompt.job, prompt.gate)];
  lines.push(`Selector: ${selectorText(prompt.selector)}`);
  if (prompt.gate === "plan") {
    lines.push("Members:");
    for (const member of prompt.members) {
      const lane = member.batch !== undefined
        ? `lane in batch ${member.batch + 1}`
        : "no lane";
      lines.push(
        `  ${member.worker}: ${member.disposition}${
          member.reason !== undefined ? ` (${member.reason})` : ""
        }, ${lane}`,
      );
    }
  }
  prompt.batches.forEach((batch, index) => {
    lines.push(`Batch ${index + 1}: ${batch.join(", ")}`);
  });
  lines.push(`Budget: ${budgetText(prompt.budget)}`);
  for (const lane of prompt.canary?.lanes ?? []) {
    lines.push(`Canary ${lane.worker}: ${lane.status}`);
    for (const failed of lane.failedSteps) {
      lines.push(
        `  failed ${failed.step}${
          failed.error !== undefined ? `: ${failed.error}` : ""
        }`,
      );
    }
    for (const assertion of lane.assertions) {
      lines.push(
        `  assertion ${assertion.step} (${assertion.severity}): ${assertion.message}`,
      );
    }
  }
  if (prompt.next !== undefined) {
    lines.push(`Next batch: ${prompt.next.join(", ")}`);
  }
  return lines.join("\n");
}
