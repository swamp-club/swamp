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

import type { ActiveRun, ActiveRunStatus } from "./active_run.ts";

export interface RunTrackerRepository {
  register(run: ActiveRun): void;

  heartbeat(runId: string): void;

  complete(runId: string, status: ActiveRunStatus, reason?: string): void;

  /**
   * marks an interrupted row's run record settled so retention may purge it;
   * until then the row is the only evidence the owner died, which recover and
   * doctor need. No-op unless interrupted and unsettled.
   */
  markSettled(runId: string, reason: string): void;

  /**
   * puts a row its owner completed back to running when the final run record
   * was not committed, so dead-owner settling finds the run. Only rows owned by
   * pid on hostname; returns whether one was put back.
   */
  reopenCompleted(runId: string, pid: number, hostname: string): boolean;

  /**
   * records reason on a row its owner completed as cancelled without one, as
   * when the owner saves its outcome before the cancel command completes the
   * row; other rows are left alone
   */
  recordCancelReason(runId: string, reason: string): void;

  /**
   * hands a suspended, failed or interrupted row to the resuming process as
   * running with a fresh heartbeat. Interrupted counts because recover resets
   * the record but not the row. False if the row is gone.
   */
  reactivate(
    runId: string,
    pid: number,
    hostname: string,
    instanceId?: string,
  ): boolean;

  findById(runId: string): ActiveRun | null;

  findAllRunning(): ActiveRun[];

  findStaleRuns(ttlMs: number): ActiveRun[];

  findAll(): ActiveRun[];

  findRecent(hours?: number): ActiveRun[];

  reapStaleRuns(ttlMs: number, instanceId?: string): ActiveRun[];

  close(): void;
}
