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

import { UserError } from "../errors.ts";
import { FAN_OUT_GATE_KINDS, fanOutGateName } from "../remote/fan_out.ts";
import type { JobData } from "./job.ts";
import { mergePlacementFields, type PlacementFields } from "./placement.ts";

export interface FanOutRefusal {
  readonly path: (string | number)[];
  readonly message: string;
}

// structural, so workflow.ts can call this from its schema without a cycle
export interface FanOutRulesInput extends PlacementFields {
  readonly affinity?: boolean;
  readonly jobs: readonly JobData[];
}

const UNSUPPORTED_STEP_KINDS: Readonly<Record<string, string>> = {
  workflow: "a nested workflow",
  manual_approval: "a manual_approval",
  wait_for_signal: "a wait_for_signal",
};

export function fanOutJobRefusals(
  workflow: FanOutRulesInput,
): FanOutRefusal[] {
  const refusals: FanOutRefusal[] = [];
  workflow.jobs.forEach((job, jobIndex) => {
    if (job.fanOut === undefined) return;
    const at = (...rest: (string | number)[]) => ["jobs", jobIndex, ...rest];
    const name = job.name;

    const selector = mergePlacementFields(workflow, job);
    if (job.target !== undefined) {
      refusals.push({
        path: at("target"),
        message:
          `Fan-out job '${name}' sets target, which names one worker. Remove target and select the workers with labels or platform.`,
      });
    } else if (selector?.target !== undefined) {
      refusals.push({
        path: ["target"],
        message:
          `The workflow sets target, which fan-out job '${name}' would inherit and which names one worker. Remove target from the workflow, or set it on the jobs that need it.`,
      });
    }

    const hasLabels = selector?.labels !== undefined &&
      Object.keys(selector.labels).length > 0;
    if (!hasLabels && selector?.platform === undefined) {
      refusals.push({
        path: at("fanOut"),
        message:
          `Fan-out job '${name}' has no labels or platform in effect. Set labels or platform on the job or the workflow; to reach every worker, give them a shared label and select it.`,
      });
    }

    if (job.affinity === true) {
      refusals.push({
        path: at("affinity"),
        message:
          `Fan-out job '${name}' sets affinity: true, but each lane already stays on its own worker. Remove affinity from the job.`,
      });
    } else if (workflow.affinity === true && job.affinity !== false) {
      refusals.push({
        path: ["affinity"],
        message:
          `The workflow sets affinity: true, which would pin fan-out job '${name}' to one worker. Set affinity: false on job '${name}' or remove affinity from the workflow.`,
      });
    }

    const gates = job.fanOut === "all" ? [] : job.fanOut.rollout?.approve ?? [];
    job.steps.forEach((step, stepIndex) => {
      const stepAt = (...rest: (string | number)[]) =>
        at("steps", stepIndex, ...rest);
      const where = `Step '${step.name}' in fan-out job '${name}'`;
      const gate = FAN_OUT_GATE_KINDS.find((kind) =>
        gates.includes(kind) && fanOutGateName(name, kind) === step.name
      );
      if (gate !== undefined) {
        refusals.push({
          path: stepAt("name"),
          message:
            `${where} has the name of the job's ${gate} approval gate. Rename the step.`,
        });
      }
      for (const field of ["target", "labels", "platform"] as const) {
        if (step[field] === undefined) continue;
        refusals.push({
          path: stepAt(field),
          message:
            `${where} sets ${field}, but each lane runs on one worker. Remove ${field} from the step and set placement on the job.`,
        });
      }
      if (step.forEach !== undefined) {
        refusals.push({
          path: stepAt("forEach"),
          message:
            `${where} uses forEach, which fan-out jobs do not support yet. Move the loop into a job without fanOut.`,
        });
      }
      const task = step.task;
      if (task.type === "model_method" && task.modelIdOrName !== undefined) {
        refusals.push({
          path: stepAt("task"),
          message:
            `${where} runs the named definition '${task.modelIdOrName}', which every lane would share. Use behaviorType and behaviorName so each worker gets its own instance.`,
        });
      }
      const kind = UNSUPPORTED_STEP_KINDS[task.type];
      if (kind !== undefined) {
        refusals.push({
          path: stepAt("task"),
          message:
            `${where} is ${kind} step, which fan-out jobs do not support yet. Move it into a job without fanOut.`,
        });
      }
    });
  });
  return refusals;
}

// a resume must never re-plan silently: an older swamp drops the plan on save
export function fanOutPlanMissing(
  job: { readonly fanOut?: unknown },
  // status alone does not mean started: a job ended unstarted has a final status
  jobRun: {
    readonly status: string;
    readonly startedAt?: unknown;
    readonly fanOutPlan?: unknown;
  },
): boolean {
  if (job.fanOut === undefined) return false;
  return jobRun.startedAt !== undefined && jobRun.fanOutPlan === undefined;
}

export const FAN_OUT_NEEDS_SERVE =
  "fanOut needs the worker pool of swamp serve; run it with --server";

interface FanOutRunWorkflow {
  readonly name: string;
  readonly jobs: readonly {
    readonly name: string;
    readonly fanOut?: unknown;
  }[];
}

// refused before anything runs: without serve there is no pool to plan from
export function refuseFanOutRun(
  workflow: FanOutRunWorkflow,
  poolAvailable: boolean,
): void {
  const fanOutJob = workflow.jobs.find((job) => job.fanOut !== undefined);
  if (fanOutJob === undefined) return;
  if (!poolAvailable) {
    throw new UserError(
      `Workflow '${workflow.name}' has fan-out job '${fanOutJob.name}': ${FAN_OUT_NEEDS_SERVE}.`,
    );
  }
}
