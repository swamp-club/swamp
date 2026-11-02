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

import { markErrorPaths, UserError } from "../errors.ts";
import type { DetectableAiTool } from "../telemetry/agent_harness_detection.ts";
import { isBriefFile } from "./brief.ts";
import { StartTask } from "./start_task.ts";

export type TrustMode = "dialog" | "passed" | "unknown";

export type LaunchMethod =
  | "macos_terminal"
  | "windows_terminal"
  | "linux_terminal"
  | "copy_command";

export type StartStep = "task" | "agent" | "trust" | "launched";

export interface StartLaunchRecord {
  readonly method: LaunchMethod;
  readonly at: string;
  readonly command: string;
  readonly opened: boolean;
}

export interface StartSessionData {
  readonly id: string;
  readonly workspacePath: string;
  readonly createdAt: string;
  readonly step: StartStep;
  readonly task?: string;
  readonly harness?: DetectableAiTool;
  readonly tools?: readonly DetectableAiTool[];
  readonly trustConfirmedAt?: string;
  readonly launch?: StartLaunchRecord;
  /** assigned once, when the task is first saved, and never changed */
  readonly briefFile?: string;
}

export class StartTransitionError extends UserError {
  constructor(command: string, step: StartStep) {
    super(`Can't ${command} at the "${step}" step. Reload the page.`);
    this.name = "StartTransitionError";
  }
}

/**
 * sign-in is deliberately not part of the aggregate: it is checked live on
 * every status read and before every launch
 */
export class StartSession {
  private constructor(private data: StartSessionData) {}

  static create(
    id: string,
    workspacePath: string,
    now: Date,
  ): StartSession {
    return new StartSession({
      id,
      workspacePath,
      createdAt: now.toISOString(),
      step: "task",
    });
  }

  /**
   * enforces the invariants: every step past task has a task, trust and
   * launched have a harness, and launched has a launch record
   */
  static fromData(data: StartSessionData): StartSession {
    if (data.task !== undefined) StartTask.create(data.task);
    const invalid = (why: string) =>
      new UserError(`Invalid start session "${data.id}": ${why}.`);
    if (data.step !== "task" && data.task === undefined) {
      throw invalid(`the "${data.step}" step has no task`);
    }
    if (
      (data.step === "trust" || data.step === "launched") &&
      data.harness === undefined
    ) {
      throw invalid(`the "${data.step}" step has no agent`);
    }
    if (data.step === "launched" && data.launch === undefined) {
      throw invalid("the launched step has no launch record");
    }
    if (data.briefFile !== undefined && !isBriefFile(data.briefFile)) {
      throw invalid("its brief path isn't a tasks/<name>.md file");
    }
    return new StartSession({ ...data });
  }

  toData(): StartSessionData {
    return { ...this.data };
  }

  get id(): string {
    return this.data.id;
  }

  get step(): StartStep {
    return this.data.step;
  }

  get task(): StartTask | undefined {
    return this.data.task === undefined
      ? undefined
      : StartTask.create(this.data.task);
  }

  get harness(): DetectableAiTool | undefined {
    return this.data.harness;
  }

  get tools(): readonly DetectableAiTool[] {
    if (this.data.tools) return this.data.tools;
    return this.data.harness ? [this.data.harness] : [];
  }

  get trustConfirmedAt(): string | undefined {
    return this.data.trustConfirmedAt;
  }

  get launch(): StartLaunchRecord | undefined {
    return this.data.launch;
  }

  get workspacePath(): string {
    return this.data.workspacePath;
  }

  get createdAt(): string {
    return this.data.createdAt;
  }

  get briefFile(): string | undefined {
    return this.data.briefFile;
  }

  assignBriefFile(briefFile: string): void {
    if (this.data.briefFile !== undefined) return;
    if (!isBriefFile(briefFile)) {
      throw markErrorPaths(
        new UserError(`Invalid task brief path ${JSON.stringify(briefFile)}.`),
        [briefFile],
      );
    }
    this.data = { ...this.data, briefFile };
  }

  saveTask(task: StartTask): void {
    this.require("save the task", ["task", "agent", "trust"]);
    this.data = {
      ...this.withoutTrust(),
      task: task.text,
      step: "agent",
    };
  }

  chooseHarness(
    harness: DetectableAiTool,
    extraTools: readonly DetectableAiTool[] = [],
  ): void {
    this.require("choose an agent", ["agent"]);
    const tools = [harness, ...extraTools.filter((t) => t !== harness)];
    this.data = {
      ...this.data,
      harness,
      tools: [...new Set(tools)],
      step: "trust",
    };
  }

  back(): void {
    this.require("go back", ["agent", "trust"]);
    this.data = {
      ...this.withoutTrust(),
      step: this.data.step === "trust" ? "agent" : "task",
    };
  }

  confirmTrustAndRecordLaunch(
    launch: Omit<StartLaunchRecord, "at">,
    now: Date,
  ): void {
    this.require("launch", ["trust", "launched"]);
    if (this.data.task === undefined || this.data.harness === undefined) {
      throw new StartTransitionError("launch", this.data.step);
    }
    const at = now.toISOString();
    this.data = {
      ...this.data,
      trustConfirmedAt: at,
      launch: { ...launch, at },
      step: "launched",
    };
  }

  assertCanLaunch(): void {
    this.require("launch", ["trust", "launched"]);
    if (this.data.task === undefined || this.data.harness === undefined) {
      throw new StartTransitionError("launch", this.data.step);
    }
  }

  private withoutTrust(): StartSessionData {
    const { trustConfirmedAt: _dropped, ...rest } = this.data;
    return rest;
  }

  private require(command: string, allowed: readonly StartStep[]): void {
    if (!allowed.includes(this.data.step)) {
      throw new StartTransitionError(command, this.data.step);
    }
  }
}
