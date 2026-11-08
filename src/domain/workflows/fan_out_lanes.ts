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

import type { FanOutMember, FanOutSelector } from "../remote/fan_out.ts";
import { describePlacement } from "../remote/scheduler.ts";
import type { PoolWorker } from "../remote/worker_pool.ts";
import { fanOutLaneName } from "./workflow_run.ts";

export interface LaneStep {
  readonly worker: string;
  readonly authored: string;
}

export interface LaneWorkerScope {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly platform: string;
  readonly arch: string;
}

export function laneStepName(step: string, worker: string): string {
  return fanOutLaneName(step, worker);
}

/**
 * step and worker names may both hold brackets, so two lanes could otherwise
 * share a step record; a plan that would is refused, never merged
 */
export function planLaneSteps(
  jobName: string,
  authoredSteps: readonly string[],
  workers: readonly string[],
): ReadonlyMap<string, LaneStep> {
  const authored = new Set(authoredSteps);
  const steps = new Map<string, LaneStep>();
  for (const worker of workers) {
    for (const step of authoredSteps) {
      const name = laneStepName(step, worker);
      const clash = steps.get(name);
      if (clash !== undefined || authored.has(name)) {
        throw new Error(
          `Fan-out job '${jobName}' cannot name its lanes: step '${step}' on worker '${worker}' gives '${name}', which ${
            clash !== undefined
              ? `step '${clash.authored}' on worker '${clash.worker}' also gives`
              : "is already a step of the job"
          }. Rename the step or the worker.`,
        );
      }
      steps.set(name, { worker, authored: step });
    }
  }
  return steps;
}

/** worker names hold no brackets (the token mint refuses them), so at most one lane matches */
export function laneStepOf(
  stepName: string,
  lanes: readonly { readonly worker: string }[] | undefined,
): LaneStep | undefined {
  for (const lane of lanes ?? []) {
    const suffix = `[${lane.worker}]`;
    if (stepName.length > suffix.length && stepName.endsWith(suffix)) {
      return {
        worker: lane.worker,
        authored: stepName.slice(0, -suffix.length),
      };
    }
  }
  return undefined;
}

/**
 * a suffix can make two hosts share an instance (behavior host on worker a-b,
 * host-a on worker b); refused at plan time for names known before the run
 */
export function refuseSharedLaneInstances(
  jobName: string,
  behaviorNames: readonly string[],
  workers: readonly string[],
): void {
  const owner = new Map<string, { behavior: string; worker: string }>();
  for (const behavior of new Set(behaviorNames)) {
    if (behavior.includes("${{")) continue;
    for (const worker of workers) {
      const instance = perWorkerBehaviorName(behavior, worker);
      const clash = owner.get(instance);
      if (clash !== undefined && clash.worker !== worker) {
        throw new Error(
          `Fan-out job '${jobName}' would run behavior '${behavior}' on worker '${worker}' and behavior '${clash.behavior}' on worker '${clash.worker}' as the same instance '${instance}'. Rename one of the behaviors.`,
        );
      }
      owner.set(instance, { behavior, worker });
    }
  }
}

/**
 * only the worker's name is unique per lane, so only a name built from it is
 * left as resolved; the authored text decides, since the value is resolved
 */
export function perWorkerBehaviorName(
  name: string,
  worker: string,
  authoredName: string = name,
): string {
  return authoredName.includes("self.worker.name") ? name : `${name}-${worker}`;
}

export function laneWorkerScope(worker: PoolWorker): LaneWorkerScope {
  return {
    name: worker.name,
    labels: { ...worker.labels },
    platform: worker.platform,
    arch: worker.arch,
  };
}

export function laneFailed(
  steps: readonly {
    readonly status: string;
    readonly allowedFailure: boolean;
  }[],
): boolean {
  return steps.some((step) => step.status === "failed" && !step.allowedFailure);
}

// skipped and excluded members never ran, so only a plan-time failure counts
export function fanOutJobFailed(
  members: readonly Pick<FanOutMember, "disposition">[],
  failedLanes: number,
): boolean {
  return failedLanes > 0 ||
    members.some((member) => member.disposition === "failed");
}

export function refusedPlanMessage(
  jobName: string,
  selector: FanOutSelector,
  live: number,
  minWorkers: number,
): string {
  return `Fan-out job '${jobName}' needs at least ${minWorkers} worker${
    minWorkers === 1 ? "" : "s"
  } matching ${
    describePlacement({ labels: selector.labels, platform: selector.platform })
  } that ${minWorkers === 1 ? "is" : "are"} connected or waiting, and ${live} ${
    live === 1 ? "is" : "are"
  }; nothing was sent.`;
}
