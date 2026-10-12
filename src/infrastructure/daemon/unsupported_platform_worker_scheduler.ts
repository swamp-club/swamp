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

import type { WorkerDaemonConfig } from "../../domain/worker/worker_daemon_config.ts";
import type {
  WorkerDaemonScheduler,
  WorkerDaemonStatus,
} from "../../domain/worker/worker_daemon_scheduler.ts";
import { UserError } from "../../domain/errors.ts";

/**
 * The worker daemon scheduler for a platform with no supported service
 * manager. No daemon can be installed there, so status reports it as not
 * configured, while enable and disable refuse.
 */
export class UnsupportedPlatformWorkerScheduler
  implements WorkerDaemonScheduler {
  private readonly reason: string;

  constructor(os: string) {
    this.reason = `swamp worker daemon is not yet supported on ${os}`;
  }

  enable(_config: WorkerDaemonConfig): Promise<void> {
    return Promise.reject(new UserError(this.reason));
  }

  disable(): Promise<void> {
    return Promise.reject(new UserError(this.reason));
  }

  status(): Promise<WorkerDaemonStatus> {
    return Promise.resolve({
      enabled: false,
      running: false,
      unsupportedReason: this.reason,
    });
  }
}
