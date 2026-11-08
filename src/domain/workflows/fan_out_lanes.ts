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
import { mergePlacementFields, type PlacementFields } from "./placement.ts";
import { fanOutLaneName, type FanOutSnapshot } from "./workflow_run.ts";

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

/**
 * the selector comes from the authored workflow, since the run's evaluated
 * one holds resolved label values that a resume cannot compare
 */
export function fanOutSnapshot(
  authored: {
    readonly placementFields: PlacementFields;
    getJob(
      name: string,
    ): { readonly placementFields: PlacementFields } | undefined;
  } | undefined,
  jobName: string,
  lanes: readonly string[],
  pool: ReadonlyMap<string, PoolWorker>,
): FanOutSnapshot {
  const job = authored?.getJob(jobName);
  const fields = job &&
    mergePlacementFields(authored!.placementFields, job.placementFields);
  return {
    ...(job !== undefined
      ? {
        selector: {
          ...(fields?.labels !== undefined ? { labels: fields.labels } : {}),
          ...(fields?.platform !== undefined
            ? { platform: fields.platform }
            : {}),
        },
      }
      : {}),
    workers: lanes.flatMap((name) => {
      const worker = pool.get(name);
      return worker === undefined ? [] : [laneWorkerScope(worker)];
    }),
  };
}

// the instance UUID stays in the run record, out of what clients are sent
export function fanOutEventMember(
  member: Pick<FanOutMember, "worker" | "disposition" | "reason">,
): Pick<FanOutMember, "worker" | "disposition" | "reason"> {
  return {
    worker: member.worker,
    disposition: member.disposition,
    ...(member.reason !== undefined ? { reason: member.reason } : {}),
  };
}

export function membersOf(
  members: readonly Pick<FanOutMember, "worker" | "disposition" | "reason">[],
  disposition: FanOutMember["disposition"],
): Pick<FanOutMember, "worker" | "disposition" | "reason">[] {
  return members.filter((member) => member.disposition === disposition)
    .map(fanOutEventMember);
}

export function laneFailed(
  steps: readonly {
    readonly status: string;
    readonly allowedFailure: boolean;
  }[],
): boolean {
  return steps.some((step) => step.status === "failed" && !step.allowedFailure);
}

// a resume keeps such a lane: its state and outputs stand, nothing is sent
export function laneSucceeded(
  steps: readonly {
    readonly status: string;
    readonly allowedFailure: boolean;
    readonly settledByAbort?: boolean;
  }[],
): boolean {
  return steps.every((step) =>
    !step.settledByAbort &&
    (step.status === "succeeded" || step.status === "skipped" ||
      (step.status === "failed" && step.allowedFailure))
  );
}

export function laneRecords<S extends { readonly stepName: string }>(
  steps: readonly S[],
  lanes: readonly { readonly worker: string }[],
): Map<string, S[]> {
  const byWorker = new Map<string, S[]>(
    lanes.map((lane) => [lane.worker, []]),
  );
  for (const step of steps) {
    const lane = laneStepOf(step.stepName, lanes);
    if (lane !== undefined) byWorker.get(lane.worker)!.push(step);
  }
  return byWorker;
}

export type ResumedLaneVerdict =
  | { kind: "run" }
  | { kind: "fail"; error: string };

/**
 * a resumed lane whose worker is not connected follows the job's offline
 * policy; skip fails it too, since a planned lane is never silently dropped
 */
export function resumedLaneVerdict(
  jobName: string,
  worker: string,
  offline: "wait" | "skip" | "fail",
  live: Pick<PoolWorker, "connected"> | undefined,
  hasScope: boolean,
): ResumedLaneVerdict {
  if (live === undefined && !hasScope) {
    return {
      kind: "fail",
      error:
        `Worker '${worker}' of fan-out job '${jobName}' has left the pool, and this run did not record its labels; start a new run.`,
    };
  }
  if (live?.connected === true || offline === "wait") return { kind: "run" };
  return {
    kind: "fail",
    error:
      `Worker '${worker}' of fan-out job '${jobName}' is not connected, and the job's offline policy is ${offline}; nothing was sent.`,
  };
}

export function sameFanOutSelector(
  a: FanOutSelector | undefined,
  b: FanOutSelector | undefined,
): boolean {
  const labels = (s: FanOutSelector | undefined) =>
    JSON.stringify(
      Object.entries(s?.labels ?? {}).sort(([x], [y]) =>
        x < y ? -1 : x > y ? 1 : 0
      ),
    );
  return labels(a) === labels(b) && a?.platform === b?.platform;
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
