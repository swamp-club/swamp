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

import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { UserError } from "../errors.ts";

export const STEP_STARTS_DIR = "starts";

const StepStartSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  jobName: z.string().min(1),
  stepName: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
}).strict();

export type StepStartData = z.infer<typeof StepStartSchema>;

/**
 * A step's start, recorded before its method runs; a run's committed starts
 * are its start journal, which recovery reads with the run's record.
 */
export class StepStart {
  readonly workflowId: string;
  readonly runId: string;
  readonly jobName: string;
  readonly stepName: string;
  /** epoch ms, the start time the step's record carries */
  readonly startedAt: number;

  private constructor(data: StepStartData) {
    this.workflowId = data.workflowId;
    this.runId = data.runId;
    this.jobName = data.jobName;
    this.stepName = data.stepName;
    this.startedAt = data.startedAt;
  }

  static create(data: StepStartData): StepStart {
    return new StepStart(StepStartSchema.parse(data));
  }

  /** refuses any field beyond a start's own, so nothing else rides in one */
  static fromYaml(content: string): StepStart {
    return StepStart.create(StepStartSchema.parse(parseYaml(content)));
  }

  get digest(): string {
    return createHash("sha256")
      .update(JSON.stringify([this.jobName, this.stepName, this.startedAt]))
      .digest("hex");
  }

  /** one start of one step has one name, so a start never overwrites another */
  get fileName(): string {
    return `${this.digest}.yaml`;
  }

  toYaml(): string {
    return stringifyYaml(this.toData());
  }

  toData(): StepStartData {
    return {
      workflowId: this.workflowId,
      runId: this.runId,
      jobName: this.jobName,
      stepName: this.stepName,
      startedAt: this.startedAt,
    };
  }

  equals(other: StepStart): boolean {
    return this.workflowId === other.workflowId &&
      this.runId === other.runId && this.jobName === other.jobName &&
      this.stepName === other.stepName && this.startedAt === other.startedAt;
  }
}

/**
 * the datastore's commit-unreachable code, so the command exits as a commit
 * that never reached storage does
 */
export const STEP_START_UNRECORDED_CODE = "datastore_v3_commit_unreachable";

export interface UnrecordedStart {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly runId: string;
  /** undefined when the run's move into running is what could not commit */
  readonly stepName?: string;
  readonly jobName?: string;
  /** set when the start that could not commit was a nested run's */
  readonly nestedRunId?: string;
}

/** endLanded: whether the run's failed record committed, so resume, not recover */
export class StepStartUnrecordedError extends UserError {
  constructor(
    cause: unknown,
    readonly start: UnrecordedStart,
    readonly endLanded?: boolean,
    readonly endFailure?: unknown,
  ) {
    const what = start.stepName === undefined
      ? `the start of workflow run ${start.runId}`
      : start.nestedRunId !== undefined
      ? `a step start in nested run ${start.nestedRunId}, under step ` +
        `${start.stepName} of workflow run ${start.runId}`
      : `the start of step ${start.stepName} of workflow run ${start.runId}`;
    const next = start.stepName === undefined
      ? `No step of it ran. Once the datastore is reachable, if swamp ` +
        `workflow history shows the run as running, run swamp workflow ` +
        `recover ${start.workflowName} --run ${start.runId}, then resume ` +
        `it; otherwise run swamp workflow run ${start.workflowName} again.`
      : endLanded === true
      ? `The run is recorded as failed; once the datastore is reachable, ` +
        `run swamp workflow resume ${start.workflowName} --run ${start.runId} ` +
        `to carry on from that step.`
      : `The run is still recorded as running; once the datastore is ` +
        `reachable, run swamp workflow recover ${start.workflowName} --run ` +
        `${start.runId}, then resume it.`;
    const end = endFailure === undefined
      ? ""
      : ` Committing the run's end also failed: ${messageOf(endFailure)}.`;
    super(
      `Swamp could not commit ${what} (${messageOf(cause)}), so the run ` +
        `stopped before ${
          start.stepName === undefined
            ? "its first step"
            : start.nestedRunId !== undefined
            ? "the nested run's step"
            : "that step"
        } ran; steps already running finished and no new step started.` +
        `${end} ${next}`,
      STEP_START_UNRECORDED_CODE,
    );
    this.name = "StepStartUnrecordedError";
    this.cause = cause;
  }

  withEnd(landed: boolean, failure?: unknown): StepStartUnrecordedError {
    return new StepStartUnrecordedError(
      this.cause,
      this.start,
      landed,
      failure,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
