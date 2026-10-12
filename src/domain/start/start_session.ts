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

/** How a harness's own folder-trust question is handled. */
export type TrustMode = "dialog" | "passed" | "unknown";

/** How the agent's window was opened. */
export type LaunchMethod =
  | "macos_terminal"
  | "windows_terminal"
  | "linux_terminal"
  | "copy_command";

/** The step a task has reached. */
export type StartStep = "task" | "agent" | "trust" | "launched";

/** The record of the latest launch. */
export interface StartLaunchRecord {
  readonly method: LaunchMethod;
  readonly at: string;
  /** The copy-paste fallback command. */
  readonly command: string;
  /** Whether a window was actually opened. */
  readonly opened: boolean;
}

/** The persisted shape of a {@link StartSession}. */
export interface StartSessionData {
  readonly id: string;
  readonly workspacePath: string;
  readonly createdAt: string;
  readonly step: StartStep;
  readonly task?: string;
  readonly harness?: DetectableAiTool;
  /**
   * Every tool to set the workspace up for on launch, the harness included:
   * the `--tool x --tool y` of `swamp repo init`.
   */
  readonly tools?: readonly DetectableAiTool[];
  readonly trustConfirmedAt?: string;
  readonly launch?: StartLaunchRecord;
  /**
   * The task's brief, relative to the workspace (`tasks/<date>-<slug>.md`).
   * Assigned once, when the task is first saved, and never changed.
   */
  readonly briefFile?: string;
}

/** Thrown when a command is not allowed from the task's current step. */
export class StartTransitionError extends UserError {
  constructor(command: string, step: StartStep) {
    super(`Can't ${command} at the "${step}" step. Reload the page.`);
    this.name = "StartTransitionError";
  }
}

/**
 * One automation task of a workspace and its pass through the `swamp start`
 * flow: the task text, the agent chosen for it, and its launches. A
 * workspace holds any number of them; none is special.
 *
 * Sign-in is deliberately not part of the aggregate: it is checked live on
 * every status read and before every launch.
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
   * Rebuilds a session from stored data, enforcing the invariants the
   * commands keep: every step past `task` has a task, `trust` and
   * `launched` have a harness, and `launched` has a launch record.
   *
   * @throws {UserError} When the data breaks one of them.
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

  /** The tools chosen for this task; the harness alone when none were. */
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

  /**
   * Gives the task its brief path. A task keeps the first one it is given.
   *
   * @throws {UserError} When the path isn't a `tasks/<name>.md` file.
   */
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

  /** Sets the task and moves to the agent step, keeping any chosen harness. */
  saveTask(task: StartTask): void {
    this.require("save the task", ["task", "agent", "trust"]);
    this.data = {
      ...this.withoutTrust(),
      task: task.text,
      step: "agent",
    };
  }

  /**
   * Picks the harness that opens and, optionally, other tools to set the
   * workspace up for. The harness is always one of the tools.
   */
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

  /** Records trust and a launch; from `launched` it means "Launch again". */
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

  /** Throws unless a launch from the current step would be accepted. */
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
