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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import type {
  InstallHealthReport,
  SchedulerTypeLabel,
} from "../../domain/update/install_health.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

function schedulerTypeDisplayLabel(type: SchedulerTypeLabel): string {
  switch (type) {
    case "daemon":
      return "LaunchDaemon (system)";
    case "agent":
      return "LaunchAgent (user)";
    case "systemd-system":
      return "systemd timer (system)";
    case "systemd-user":
      return "systemd timer (user)";
    case "cron-root":
      return "cron (root)";
    case "cron-user":
      return "cron (user)";
  }
}

export type InstallHealthStatus = "healthy" | "unhealthy";

export interface DoctorInstallRenderer {
  render(report: InstallHealthReport): void;
  readonly overallStatus: InstallHealthStatus;
}

class LogDoctorInstallRenderer implements DoctorInstallRenderer {
  overallStatus: InstallHealthStatus = "healthy";

  render(report: InstallHealthReport): void {
    writeOutput(bold(cyan("Installation Health Check")));
    writeOutput("");

    writeOutput(`  Binary path:    ${report.binaryPath}`);
    writeOutput(`  Version:        ${report.currentVersion}`);

    if (report.owner.uid !== null) {
      const ownerLabel = report.owner.isRoot
        ? `root ${dim("(uid 0)")}`
        : `${report.owner.username ?? `uid:${report.owner.uid}`}`;
      writeOutput(`  Binary owner:   ${ownerLabel}`);
    }

    const writableIcon = report.writable === "pass" ? green("✓") : red("✗");
    writeOutput(`  Writable:       ${writableIcon} ${report.writableMessage}`);

    writeOutput("");
    writeOutput(bold(cyan("Autoupdate")));
    writeOutput("");

    writeOutput(
      `  Enabled:        ${report.autoupdate.enabled ? "yes" : "no"}`,
    );
    if (report.autoupdate.enabled) {
      writeOutput(`  Cadence:        ${report.autoupdate.cadence}`);
      if (report.autoupdate.schedulerType) {
        const typeLabel = schedulerTypeDisplayLabel(
          report.autoupdate.schedulerType,
        );
        writeOutput(`  Scheduler type: ${typeLabel}`);
      }
      writeOutput(
        `  Scheduler:      ${
          report.autoupdate.schedulerInstalled
            ? green("installed")
            : red("not installed")
        }`,
      );
    }

    const last = report.autoupdate.lastEntry;
    if (last) {
      const outcomeLabel = last.outcome === "updated"
        ? green("updated")
        : last.outcome === "up_to_date"
        ? dim("up to date")
        : red("error");
      writeOutput(`  Last check:     ${last.timestamp} (${outcomeLabel})`);
      if (last.outcome === "updated" && last.versionAfter) {
        writeOutput(
          `  Last update:    ${last.versionBefore} → ${last.versionAfter}`,
        );
      }
      if (last.outcome === "error" && last.error) {
        writeOutput(`  Last error:     ${red(last.error)}`);
      }
    } else if (report.autoupdate.enabled) {
      writeOutput(`  Last check:     ${dim("no history yet")}`);
    }

    const hasProblem = report.writable === "fail" ||
      (report.autoupdate.enabled && !report.autoupdate.schedulerInstalled) ||
      last?.outcome === "error";

    if (hasProblem) {
      this.overallStatus = "unhealthy";
      writeOutput("");

      if (report.writable === "fail" && report.autoupdate.enabled) {
        writeOutput(
          yellow("  ⚠ Autoupdate is enabled but the binary is not writable."),
        );
        writeOutput(
          `    The background scheduler cannot replace ${report.binaryPath}.`,
        );
        writeOutput(
          `    Run ${
            bold("`sudo swamp update`")
          } to update manually, or disable with:`,
        );
        writeOutput(`    ${bold("`swamp update --setup-auto disable`")}`);
      }
    }

    writeOutput("");
    const status = this.overallStatus === "healthy"
      ? green(bold("HEALTHY"))
      : red(bold("UNHEALTHY"));
    writeOutput(status);
  }
}

class JsonDoctorInstallRenderer implements DoctorInstallRenderer {
  overallStatus: InstallHealthStatus = "healthy";

  render(report: InstallHealthReport): void {
    const hasProblem = report.writable === "fail" ||
      (report.autoupdate.enabled &&
        !report.autoupdate.schedulerInstalled) ||
      report.autoupdate.lastEntry?.outcome === "error";

    this.overallStatus = hasProblem ? "unhealthy" : "healthy";

    console.log(JSON.stringify(
      {
        ...report,
        overallStatus: this.overallStatus,
      },
      null,
      2,
    ));
  }
}

export function createDoctorInstallRenderer(
  mode: OutputMode,
): DoctorInstallRenderer {
  switch (mode) {
    case "json":
      return new JsonDoctorInstallRenderer();
    case "log":
      return new LogDoctorInstallRenderer();
  }
}
