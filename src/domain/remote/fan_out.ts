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

// in remote, not with workflow placement: workflows imports remote, never the reverse
import { z } from "zod";

// whole percentages only; each schema checks its own bounds
const PERCENT = /^(\d{1,3})%$/;

export function parsePercent(value: string): number | null {
  const match = PERCENT.exec(value);
  return match === null ? null : Number(match[1]);
}

function percentSchema(min: number) {
  return z.string().refine((value) => {
    const pct = parsePercent(value);
    return pct !== null && pct >= min && pct <= 100;
  }, { message: `Expected a whole percentage from ${min}% to 100%` });
}

export const RolloutBatchSizeSchema = z.union([
  z.number().int().min(1),
  percentSchema(1),
]);

export type RolloutBatchSize = z.infer<typeof RolloutBatchSizeSchema>;

export const FailureBudgetSchema = z.union([
  z.number().int().min(0),
  percentSchema(0),
]);

export type FailureBudget = z.infer<typeof FailureBudgetSchema>;

export const FanOutGateKindSchema = z.enum(["plan", "canary"]);

export type FanOutGateKind = z.infer<typeof FanOutGateKindSchema>;

export const FAN_OUT_GATE_KINDS: readonly FanOutGateKind[] = ["plan", "canary"];

// the lane form job[worker]; a plan with gates refuses a worker of this name
export function fanOutGateWorker(kind: FanOutGateKind): string {
  return `approve-${kind}`;
}

export function fanOutGateName(jobName: string, kind: FanOutGateKind): string {
  return `${jobName}[${fanOutGateWorker(kind)}]`;
}

export function fanOutGateOf(
  jobName: string,
  stepName: string,
): FanOutGateKind | undefined {
  return FAN_OUT_GATE_KINDS.find((kind) =>
    fanOutGateName(jobName, kind) === stepName
  );
}

/**
 * a lane record wins over a gate name: without approve, step job on a worker
 * named approve-plan is a lane, and a plan with that gate refuses such a worker
 */
export function fanOutGateRecordOf(
  jobName: string,
  stepName: string,
  lanes: readonly { readonly worker: string }[],
): FanOutGateKind | undefined {
  const isLane = lanes.some((lane) =>
    stepName.length > lane.worker.length + 2 &&
    stepName.endsWith(`[${lane.worker}]`)
  );
  return isLane ? undefined : fanOutGateOf(jobName, stepName);
}

export const RolloutPolicySchema = z.object({
  batches: z.array(RolloutBatchSizeSchema).min(1),
  maxFailures: FailureBudgetSchema.optional(),
  approve: z.array(FanOutGateKindSchema).min(1).optional(),
  // seconds, as a manual_approval step's timeout
  approveTimeout: z.number().int().positive().optional(),
}).superRefine((rollout, ctx) => {
  const gates = rollout.approve ?? [];
  if (new Set(gates).size !== gates.length) {
    ctx.addIssue({
      code: "custom",
      path: ["approve"],
      message: "approve lists a gate more than once",
    });
  }
  if (gates.includes("canary") && rollout.batches.length < 2) {
    ctx.addIssue({
      code: "custom",
      path: ["approve"],
      message:
        "approve: canary needs a batch after the canary; add batches, for example [1, 100%]",
    });
  }
  if (rollout.approveTimeout !== undefined && gates.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["approveTimeout"],
      message: "approveTimeout needs approve: plan, canary, or both",
    });
  }
  const last = rollout.batches.length - 1;
  rollout.batches.forEach((size, index) => {
    const isRest = size === "100%";
    if (index === last && !isRest) {
      ctx.addIssue({
        code: "custom",
        path: ["batches", index],
        message: 'The last batch must be "100%" (the rest of the lanes)',
      });
    }
    if (index !== last && isRest) {
      ctx.addIssue({
        code: "custom",
        path: ["batches", index],
        message: 'Only the last batch may be "100%"',
      });
    }
  });
});

export type RolloutPolicy = z.infer<typeof RolloutPolicySchema>;

export const OfflinePolicySchema = z.enum(["wait", "skip", "fail"]);

export type OfflinePolicy = z.infer<typeof OfflinePolicySchema>;

export const FanOutPolicySchema = z.object({
  offline: OfflinePolicySchema.default("wait"),
  // never 0: a plan that reaches nobody is refused, not a success
  minWorkers: z.number().int().min(1).default(1),
  rollout: RolloutPolicySchema.optional(),
});

export type FanOutPolicy = z.output<typeof FanOutPolicySchema>;

// no target: a target names one worker, the opposite of a fan-out
export interface FanOutSelector {
  readonly labels?: Readonly<Record<string, string>>;
  readonly platform?: string;
}

export type FanOutDisposition =
  | "dispatch"
  | "waiting"
  | "skipped"
  | "failed"
  | "excluded";

export type FanOutReason = "disconnected" | "unverified" | "draining";

export interface FanOutMember {
  readonly worker: string;
  readonly instanceUuid: string;
  readonly disposition: FanOutDisposition;
  readonly reason?: FanOutReason;
}

// rollout percentages are taken of plannedLanes; a null maxFailures means no budget
export type FanOutPlan =
  | {
    readonly kind: "planned";
    readonly members: readonly FanOutMember[];
    readonly plannedLanes: number;
    readonly maxFailures: number | null;
  }
  | {
    readonly kind: "refused";
    readonly reason: "min_workers";
    readonly live: number;
    readonly minWorkers: number;
  };

export function hasLane(member: FanOutMember): boolean {
  return member.disposition === "dispatch" ||
    member.disposition === "waiting";
}

// a percentage rounds down, so the budget never tolerates more than asked
export function resolveMaxFailures(
  budget: FailureBudget | undefined,
  plannedLanes: number,
): number | null {
  if (budget === undefined) return null;
  if (typeof budget === "number") return budget;
  const pct = parsePercent(budget);
  if (pct === null) {
    throw new Error(`Invalid failure budget '${budget}'`);
  }
  return Math.floor((pct * plannedLanes) / 100);
}
