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

import type { WorkerDaemonScheduler } from "../../domain/worker/worker_daemon_scheduler.ts";
import type { LaunchdMode } from "../update/launchd_scheduler.ts";
import { UserError } from "../../domain/errors.ts";
import { LaunchdWorkerScheduler } from "./launchd_worker_scheduler.ts";
import { SystemdWorkerScheduler } from "./systemd_worker_scheduler.ts";
import { hasSystemctl } from "./has_systemctl.ts";

export interface WorkerDaemonSchedulerOptions {
  mode?: LaunchdMode;
}

export async function createWorkerDaemonScheduler(
  options?: WorkerDaemonSchedulerOptions,
): Promise<WorkerDaemonScheduler> {
  const mode = options?.mode ?? "agent";
  switch (Deno.build.os) {
    case "darwin":
      return new LaunchdWorkerScheduler(mode);
    case "linux":
      if (await hasSystemctl()) {
        return new SystemdWorkerScheduler(mode);
      }
      throw new UserError(
        "swamp worker daemon currently requires systemd on Linux, but systemctl was not found.\n" +
          "If you need support for your init system, please file a feature request:\n\n" +
          "  swamp issue feature",
      );
    default:
      throw new UserError(
        `swamp worker daemon is not yet supported on ${Deno.build.os}`,
      );
  }
}
