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
   * Hands a run's row to the process resuming it: a suspended, failed, or
   * interrupted row becomes running with the resuming pid and hostname and a
   * fresh heartbeat. Running, succeeded, and cancelled rows are left alone.
   * Interrupted is accepted because `workflow recover` sets the run record
   * back to suspended while its row stays interrupted.
   */
  reactivate(runId: string, pid: number, hostname: string): void;

  findById(runId: string): ActiveRun | null;

  findAllRunning(): ActiveRun[];

  findStaleRuns(ttlMs: number): ActiveRun[];

  findAll(): ActiveRun[];

  findRecent(hours?: number): ActiveRun[];

  reapStaleRuns(ttlMs: number, instanceId?: string): ActiveRun[];

  close(): void;
}
