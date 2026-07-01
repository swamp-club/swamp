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

export const STALE_TTL_MS = 90_000;

export const RunKinds = ["model_method", "workflow"] as const;
export type RunKind = typeof RunKinds[number];

export const ActiveRunStatuses = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "suspended",
] as const;
export type ActiveRunStatus = typeof ActiveRunStatuses[number];

export interface ActiveRunData {
  readonly id: string;
  readonly runKind: RunKind;
  readonly modelType: string | null;
  readonly methodName: string | null;
  readonly workflowName: string | null;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly status: ActiveRunStatus;
}

export class ActiveRun {
  private _status: ActiveRunStatus;
  private _heartbeatAt: Date;

  readonly id: string;
  readonly runKind: RunKind;
  readonly modelType: string | null;
  readonly methodName: string | null;
  readonly workflowName: string | null;
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: Date;

  private constructor(data: ActiveRunData) {
    this.id = data.id;
    this.runKind = data.runKind;
    this.modelType = data.modelType;
    this.methodName = data.methodName;
    this.workflowName = data.workflowName;
    this.pid = data.pid;
    this.hostname = data.hostname;
    this.startedAt = new Date(data.startedAt);
    this._heartbeatAt = new Date(data.heartbeatAt);
    this._status = data.status;
  }

  get status(): ActiveRunStatus {
    return this._status;
  }

  get heartbeatAt(): Date {
    return this._heartbeatAt;
  }

  static createModelMethodRun(opts: {
    id: string;
    modelType: string;
    methodName: string;
    pid: number;
    hostname: string;
  }): ActiveRun {
    const now = new Date().toISOString();
    return new ActiveRun({
      id: opts.id,
      runKind: "model_method",
      modelType: opts.modelType,
      methodName: opts.methodName,
      workflowName: null,
      pid: opts.pid,
      hostname: opts.hostname,
      startedAt: now,
      heartbeatAt: now,
      status: "running",
    });
  }

  static createWorkflowRun(opts: {
    id: string;
    workflowName: string;
    pid: number;
    hostname: string;
  }): ActiveRun {
    const now = new Date().toISOString();
    return new ActiveRun({
      id: opts.id,
      runKind: "workflow",
      modelType: null,
      methodName: null,
      workflowName: opts.workflowName,
      pid: opts.pid,
      hostname: opts.hostname,
      startedAt: now,
      heartbeatAt: now,
      status: "running",
    });
  }

  static fromData(data: ActiveRunData): ActiveRun {
    return new ActiveRun(data);
  }

  toData(): ActiveRunData {
    return {
      id: this.id,
      runKind: this.runKind,
      modelType: this.modelType,
      methodName: this.methodName,
      workflowName: this.workflowName,
      pid: this.pid,
      hostname: this.hostname,
      startedAt: this.startedAt.toISOString(),
      heartbeatAt: this._heartbeatAt.toISOString(),
      status: this._status,
    };
  }

  recordHeartbeat(): void {
    if (this._status !== "running") {
      throw new Error(
        `Cannot heartbeat a run in status '${this._status}'`,
      );
    }
    this._heartbeatAt = new Date();
  }

  markCompleted(): void {
    if (this._status !== "running") {
      throw new Error(
        `Cannot mark run as completed from status '${this._status}'`,
      );
    }
    this._status = "completed";
  }

  markFailed(): void {
    if (this._status !== "running") {
      throw new Error(
        `Cannot mark run as failed from status '${this._status}'`,
      );
    }
    this._status = "failed";
  }

  markCancelled(): void {
    if (this._status !== "running") {
      throw new Error(
        `Cannot mark run as cancelled from status '${this._status}'`,
      );
    }
    this._status = "cancelled";
  }

  isStale(ttlMs: number): boolean {
    if (this._status !== "running") return false;
    return Date.now() - this._heartbeatAt.getTime() > ttlMs;
  }
}
