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

import { bold, dim, green, red } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { ServiceStatus } from "../../domain/serve/service_scheduler.ts";
import type { OutputMode } from "./output.ts";

export function renderDaemonEnabled(mode: OutputMode): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify({ enabled: true }, null, 2));
  } else {
    writeOutput(
      `${green("✓")} Daemon enabled — swamp serve will start automatically`,
    );
  }
}

export function renderDaemonDisabled(mode: OutputMode): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify({ enabled: false }, null, 2));
  } else {
    writeOutput(`${green("✓")} Daemon disabled — service definition removed`);
  }
}

export function renderDaemonStatus(
  status: ServiceStatus,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // deno-lint-ignore no-console
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (!status.enabled) {
    writeOutput(`${dim("Status:")} ${dim("not configured")}`);
    writeOutput(
      `${dim("Run")} ${bold("swamp serve daemon enable")} ${
        dim("to set up the daemon")
      }`,
    );
    return;
  }

  const stateLabel = status.running ? green("running") : red("stopped");

  writeOutput(`${dim("Status:")}  ${stateLabel}`);
  writeOutput(`${dim("Enabled:")} ${green("yes")}`);
  if (status.pid !== undefined) {
    writeOutput(`${dim("PID:")}     ${String(status.pid)}`);
  }
  if (status.logPath) {
    writeOutput(`${dim("Logs:")}    ${status.logPath}`);
  }
}
