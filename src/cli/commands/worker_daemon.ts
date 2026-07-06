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
import { groupCommandAction } from "../group_action.ts";
import { UserError } from "../../domain/errors.ts";
import { resolveServiceMode } from "../../infrastructure/daemon/service_scheduler_factory.ts";
import { createWorkerDaemonScheduler } from "../../infrastructure/daemon/worker_daemon_scheduler_factory.ts";
import {
  renderWorkerDaemonDisabled,
  renderWorkerDaemonEnabled,
  renderWorkerDaemonStatus,
} from "../../presentation/output/worker_daemon_output.ts";
import { toServiceMode } from "../../presentation/output/serve_daemon_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export function collectWorkerExtraArgs(options: AnyOptions): string[] {
  const args: string[] = [];
  if (options.dataPlaneUrl) {
    args.push("--data-plane-url", options.dataPlaneUrl as string);
  }
  if (options.reconnect === false) {
    args.push("--no-reconnect");
  }
  return args;
}

export function collectWorkerEnv(options: AnyOptions): Record<string, string> {
  const env: Record<string, string> = {};

  const url = options.url as string | undefined;
  if (url) {
    env["SWAMP_ORCHESTRATOR_URL"] = url;
  }

  const token = options.token as string | undefined;
  if (token) {
    env["SWAMP_WORKER_TOKEN"] = token;
  }

  const serverToken = options.serverToken as string | undefined;
  if (serverToken) {
    env["SWAMP_SERVER_TOKEN"] = serverToken;
  }

  const labels = options.label as string[] | undefined;
  if (labels && labels.length > 0) {
    env["SWAMP_WORKER_LABELS"] = labels.join(",");
  }

  const cacheDir = options.cacheDir as string | undefined;
  if (cacheDir) {
    env["SWAMP_WORKER_CACHE_DIR"] = cacheDir;
  }

  const maxDispatches = options.maxDispatches as number | undefined;
  if (maxDispatches !== undefined) {
    env["SWAMP_WORKER_MAX_DISPATCHES"] = String(maxDispatches);
  }

  const idleTimeout = options.idleTimeout as string | undefined;
  if (idleTimeout) {
    env["SWAMP_WORKER_IDLE_TIMEOUT"] = idleTimeout;
  }

  return env;
}

const daemonEnableCommand = new Command()
  .name("enable")
  .description("Enable swamp worker as a system daemon (launchd/systemd)")
  .arguments("[url:string]")
  .option(
    "--user",
    "Install as a per-user service (systemd --user / launchd agent)",
  )
  .option(
    "--token <token:string>",
    "Enrollment token (<name>.<secret>)",
  )
  .option(
    "--server-token <token:string>",
    "Server access token for authenticating the WebSocket connection (<name>.<secret>)",
  )
  .option(
    "--label <label:string>",
    "Scheduling label key=value (repeatable)",
    { collect: true },
  )
  .option(
    "--cache-dir <dir:string>",
    "Bundle/asset cache directory; also stores the machine id",
  )
  .option(
    "--data-plane-url <url:string>",
    "Override the data-plane base URL",
  )
  .option(
    "--max-dispatches <n:number>",
    "Drain and exit 0 after N dispatches complete",
  )
  .option(
    "--idle-timeout <duration:string>",
    "Drain and exit 0 after being continuously idle for this duration (e.g. 30s, 5m, 1h)",
  )
  .option("--no-reconnect", "Exit when the control socket closes")
  .example(
    "Enable worker daemon",
    "swamp worker daemon enable wss://orch:9090 --token tok.secret --label tier=ci --cache-dir /var/lib/swamp-worker",
  )
  .example(
    "Enable with a token-authenticated orchestrator",
    "swamp worker daemon enable wss://orch:9090 --token tok.secret --server-token admin.secret --label tier=ci",
  )
  .example(
    "Enable with lifecycle policies",
    "swamp worker daemon enable wss://orch:9090 --token tok.secret --max-dispatches 100 --idle-timeout 30m",
  )
  .action(async function (options: AnyOptions, urlArg?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "worker",
      "daemon",
      "enable",
    ]);

    if (!urlArg) {
      throw new UserError(
        "Missing orchestrator URL — pass it as a positional argument:\n\n" +
          "  swamp worker daemon enable wss://orchestrator:9090 --token <token>",
      );
    }
    if (!options.token) {
      throw new UserError(
        "Missing enrollment token — pass --token:\n\n" +
          "  swamp worker daemon enable wss://orchestrator:9090 --token <name>.<secret>",
      );
    }

    const resolvedOptions = { ...options, url: urlArg };
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createWorkerDaemonScheduler({ mode });
    const extraArgs = collectWorkerExtraArgs(options);
    const env = collectWorkerEnv(resolvedOptions);

    await scheduler.enable({
      binaryPath: Deno.execPath(),
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      cacheDir: options.cacheDir as string | undefined,
    });

    renderWorkerDaemonEnabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonDisableCommand = new Command()
  .name("disable")
  .description("Disable and remove the swamp worker daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Disable worker daemon", "swamp worker daemon disable")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "worker",
      "daemon",
      "disable",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createWorkerDaemonScheduler({ mode });

    await scheduler.disable();

    renderWorkerDaemonDisabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonStatusCommand = new Command()
  .name("status")
  .description("Show the status of the swamp worker daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Check worker daemon status", "swamp worker daemon status")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "worker",
      "daemon",
      "status",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createWorkerDaemonScheduler({ mode });

    const status = await scheduler.status();

    renderWorkerDaemonStatus(status, ctx.outputMode, toServiceMode(mode));
  });

export const workerDaemonCommand = new Command()
  .name("daemon")
  .description("Manage swamp worker as a system daemon (EXPERIMENTAL)")
  .action(groupCommandAction)
  .command("enable", daemonEnableCommand)
  .command("disable", daemonDisableCommand)
  .command("status", daemonStatusCommand);
