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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { VERSION } from "./version.ts";
import {
  checkInstallHealth,
  type InstallHealthDeps,
} from "../../domain/update/install_health.ts";
import { UpdatePreferencesFileRepository } from "../../infrastructure/update/update_preferences_file_repository.ts";
import { AutoupdateLogFileRepository } from "../../infrastructure/update/autoupdate_log_file_repository.ts";
import {
  createScheduler,
  resolveLaunchdMode,
} from "../../infrastructure/update/scheduler_factory.ts";
import {
  autoupdateLogPath,
  detectInstalledLaunchdMode,
} from "../../infrastructure/update/launchd_scheduler.ts";
import { detectInstalledSystemdMode } from "../../infrastructure/update/systemd_scheduler.ts";
import {
  cronLogPath,
  detectInstalledCronMode,
} from "../../infrastructure/update/cron_scheduler.ts";
import type { SchedulerTypeLabel } from "../../domain/update/install_health.ts";
import { createDoctorInstallRenderer } from "../../presentation/renderers/doctor_install.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function createProductionDeps(): InstallHealthDeps {
  const binaryPath = Deno.execPath();
  return {
    binaryPath,
    currentVersion: VERSION,
    statBinary: async () => {
      try {
        const stat = await Deno.stat(binaryPath);
        return { uid: stat.uid };
      } catch {
        return { uid: null };
      }
    },
    probeBinaryWritable: async () => {
      const probeFile = binaryPath + ".swamp-write-test";
      try {
        await Deno.writeTextFile(probeFile, "");
        await Deno.remove(probeFile);
        return true;
      } catch {
        return false;
      }
    },
    getCurrentUid: () => {
      try {
        return Deno.uid();
      } catch {
        return null;
      }
    },
    getCurrentUsername: () => Deno.env.get("USER") ?? null,
    getPreferences: async () => {
      const repo = new UpdatePreferencesFileRepository();
      return await repo.read();
    },
    getSchedulerStatus: async () => {
      const launchdMode = await resolveLaunchdMode();
      const scheduler = await createScheduler({ launchdMode });
      return await scheduler.status();
    },
    getSchedulerType: async (): Promise<SchedulerTypeLabel | null> => {
      if (Deno.build.os === "darwin") {
        return await detectInstalledLaunchdMode();
      }
      if (Deno.build.os === "linux") {
        const systemdMode = await detectInstalledSystemdMode();
        if (systemdMode) {
          return systemdMode === "daemon" ? "systemd-system" : "systemd-user";
        }
        const cronMode = await detectInstalledCronMode();
        if (cronMode) {
          return cronMode === "daemon" ? "cron-root" : "cron-user";
        }
      }
      return null;
    },
    getLastLogEntry: async () => {
      const mode = await resolveLaunchdMode();
      let logPath: string | undefined;
      if (mode === "daemon") {
        if (Deno.build.os === "darwin") {
          logPath = autoupdateLogPath("daemon");
        } else if (Deno.build.os === "linux") {
          logPath = cronLogPath("daemon");
        }
      }
      const logRepo = new AutoupdateLogFileRepository(logPath);
      const entries = await logRepo.readAll();
      return entries.length > 0 ? entries[entries.length - 1] : null;
    },
  };
}

export const doctorInstallCommand = new Command()
  .description(
    "Check swamp installation health: binary ownership, writability, autoupdate status.",
  )
  .example("Check installation", "swamp doctor install")
  .example("Machine-readable output", "swamp doctor install --json")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "doctor",
      "install",
    ]);
    cliCtx.logger.debug("Executing doctor install command");

    const deps = createProductionDeps();
    const report = await checkInstallHealth(deps);

    const renderer = createDoctorInstallRenderer(cliCtx.outputMode);
    renderer.render(report);

    cliCtx.logger.debug("doctor install command completed");

    if (renderer.overallStatus === "unhealthy") {
      Deno.exit(1);
    }
  });
