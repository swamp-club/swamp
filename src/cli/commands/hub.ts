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
import { ensureDir } from "@std/fs";
import { resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { groupCommandAction } from "../group_action.ts";
import { UserError } from "../../domain/errors.ts";
import { HUB_SERVICE } from "../../domain/serve/service_config.ts";
import { createServiceScheduler } from "../../infrastructure/daemon/service_scheduler_factory.ts";
import { locateHubBinaries } from "../../infrastructure/process/hub_binary.ts";
import {
  hubDir,
  hubRecordPath,
} from "../../infrastructure/persistence/hub_record.ts";
import { refuseSymlinks } from "../../infrastructure/persistence/start_session_file_repository.ts";
import {
  getSwampConfigDir,
  getSwampDataDir,
} from "../../infrastructure/persistence/paths.ts";
import {
  renderDaemonDisabled,
  renderDaemonEnabled,
  renderDaemonStatus,
} from "../../presentation/output/serve_daemon_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** the hub runs as the user, never system-wide: it serves one user's workspaces */
const HUB_SERVICE_MODE = "agent";

/** the hub's argv as a service: no idle exit, a fixed loopback address */
export function hubServiceArgs(
  engine: string,
  bind: string,
  dataDir: string,
): string[] {
  return [
    "hub",
    "--engine",
    engine,
    "--bind",
    bind,
    "--record",
    hubRecordPath(dataDir),
  ];
}

const hubDaemonEnableCommand = new Command()
  .name("enable")
  .description(
    "Run your swamp hub as a user service, so swamp start and swamp dashboard\n" +
      "find it running instead of starting one",
  )
  .option("--bind <address:string>", "Address the hub listens on", {
    default: "127.0.0.1:9870",
  })
  .example("Enable the hub service", "swamp hub daemon enable")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "hub",
      "daemon",
      "enable",
    ]);
    const binaries = await locateHubBinaries();
    if (binaries === null) {
      throw new UserError(
        "This swamp install has no hub: swamp-serve isn't next to the swamp executable. Install a swamp release that includes it, or set SWAMP_SERVE_BINARY.",
        "hub_unavailable",
      );
    }
    const dataDir = resolve(getSwampDataDir());
    await refuseSymlinks([dataDir, hubDir(dataDir)]);
    await ensureDir(hubDir(dataDir));
    const scheduler = await createServiceScheduler({
      mode: HUB_SERVICE_MODE,
      identity: HUB_SERVICE,
    });
    await scheduler.enable({
      binaryPath: binaries.hub,
      repoDir: dataDir,
      port: 0,
      host: "",
      argv: hubServiceArgs(
        await Deno.realPath(binaries.engine),
        options.bind as string,
        dataDir,
      ),
      env: {
        SWAMP_HOME: dataDir,
        SWAMP_CONFIG_DIR: resolve(getSwampConfigDir()),
      },
    });
    renderDaemonEnabled(ctx.outputMode, "user");
  });

const hubDaemonDisableCommand = new Command()
  .name("disable")
  .description("Stop and remove the swamp hub user service")
  .example("Disable the hub service", "swamp hub daemon disable")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "hub",
      "daemon",
      "disable",
    ]);
    const scheduler = await createServiceScheduler({
      mode: HUB_SERVICE_MODE,
      identity: HUB_SERVICE,
    });
    await scheduler.disable();
    renderDaemonDisabled(ctx.outputMode, "user");
  });

const hubDaemonStatusCommand = new Command()
  .name("status")
  .description("Show the status of the swamp hub user service")
  .example("Check the hub service", "swamp hub daemon status")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "hub",
      "daemon",
      "status",
    ]);
    const scheduler = await createServiceScheduler({
      mode: HUB_SERVICE_MODE,
      identity: HUB_SERVICE,
    });
    renderDaemonStatus(
      await scheduler.status(),
      ctx.outputMode,
      "user",
      "swamp hub daemon enable",
    );
  });

const hubDaemonCommand = new Command()
  .name("daemon")
  .description("Manage the swamp hub as a user service (EXPERIMENTAL)")
  .action(groupCommandAction)
  .command("enable", hubDaemonEnableCommand)
  .command("disable", hubDaemonDisableCommand)
  .command("status", hubDaemonStatusCommand);

export const hubCommand = new Command()
  .name("hub")
  .description(
    "Manage your swamp hub: the one local server that serves swamp start and\n" +
      "swamp dashboard pages for every workspace (EXPERIMENTAL)",
  )
  .action(groupCommandAction)
  .command("daemon", hubDaemonCommand);
