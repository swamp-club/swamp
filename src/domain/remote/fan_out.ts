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

export const RolloutPolicySchema = z.object({
  batches: z.array(RolloutBatchSizeSchema).min(1),
  maxFailures: FailureBudgetSchema.optional(),
}).superRefine((rollout, ctx) => {
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
