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
import { isAbsolute, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { groupCommandAction } from "../group_action.ts";
import { UserError } from "../../domain/errors.ts";
import { readTokenFile } from "../remote_run.ts";
import { resolveServiceMode } from "../../infrastructure/daemon/service_scheduler_factory.ts";
import { createWorkerDaemonScheduler } from "../../infrastructure/daemon/worker_daemon_scheduler_factory.ts";
import {
  renderWorkerDaemonDisabled,
  renderWorkerDaemonEnabled,
  renderWorkerDaemonStatus,
} from "../../presentation/output/worker_daemon_output.ts";
import { toServiceMode } from "../../presentation/output/serve_daemon_output.ts";
import { getSwampConfigDir } from "../../infrastructure/persistence/paths.ts";
import { parseTimerDuration } from "../duration_parser.ts";
import { parseExtraHeaders } from "../../domain/auth/extra_headers.ts";
import {
  parseCommaSeparatedLabels,
  parseConcurrency,
  parseLabels,
  validateMaxDispatches,
  validateOrchestratorUrl,
} from "./worker_shared.ts";

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

export async function validateCacheDir(
  rawPath: string,
): Promise<string> {
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  try {
    const stat = await Deno.stat(resolved);
    if (!stat.isDirectory) {
      throw new UserError(
        `--cache-dir is not a directory: ${resolved}\n\n` +
          `  Create it with: mkdir -p ${resolved}`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof Deno.errors.NotFound) {
      throw new UserError(
        `--cache-dir does not exist: ${resolved}\n\n` +
          `  Create it with: mkdir -p ${resolved}`,
      );
    }
    throw err;
  }
  return resolved;
}

export async function validateCaCertFile(rawPath: string): Promise<string> {
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  try {
    const stat = await Deno.stat(resolved);
    if (!stat.isFile) {
      throw new UserError(`--ca-cert is not a file: ${resolved}`);
    }
  } catch (err: unknown) {
    if (err instanceof Deno.errors.NotFound) {
      throw new UserError(`--ca-cert does not exist: ${resolved}`);
    }
    throw err;
  }
  return resolved;
}

/**
 * Refuses, before anything is written, every value `swamp worker connect`
 * would refuse when the service starts — otherwise the service restarts
 * on the same error forever. Labels are checked in the comma-joined form
 * the service reads back from SWAMP_WORKER_LABELS.
 */
export function validateWorkerDaemonOptions(
  url: string,
  options: AnyOptions,
): void {
  validateOrchestratorUrl(url);
  if (options.maxDispatches !== undefined) {
    validateMaxDispatches(options.maxDispatches as number);
  }
  if (options.idleTimeout) {
    parseTimerDuration(options.idleTimeout as string, "--idle-timeout");
  }
  if (options.concurrency !== undefined) {
    parseConcurrency(options.concurrency as string);
  }
  const labels = options.label as string[] | undefined;
  if (labels && labels.length > 0) {
    parseLabels(labels);
    try {
      parseCommaSeparatedLabels(labels.join(","));
    } catch {
      throw new UserError(
        "A --label value contains a comma the service cannot read back — " +
          "the service receives labels comma-separated, so each comma must " +
          "start another key=value",
      );
    }
  }
}

/**
 * SWAMP_SERVE_EXTRA_HEADERS from the shell running `daemon enable`. swamp
 * takes pass-through headers from this variable only, never a flag, so the
 * service gets the value `worker connect` would read in the same shell.
 */
export function captureExtraHeaders(
  getEnv: () => string | undefined = () =>
    Deno.env.get("SWAMP_SERVE_EXTRA_HEADERS"),
): { raw: string; names: string[] } | undefined {
  const raw = getEnv();
  if (!raw) return undefined;
  return { raw, names: Object.keys(parseExtraHeaders(raw)) };
}

/**
 * The environment every worker daemon starts with, before its options. A
 * system-mode service runs as another user with another HOME, so it is
 * pointed at the enabling user's config dir — where the swamp-club
 * credential and cached proof the auth gate needs live — as serve daemons
 * already are. No secret is written into the service definition.
 */
export function workerDaemonBaseEnv(): Record<string, string> {
  return { SWAMP_CONFIG_DIR: resolve(getSwampConfigDir()) };
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

  const serverTokenFile = options.serverTokenFile as string | undefined;
  if (serverTokenFile) {
    env["SWAMP_SERVER_TOKEN_FILE"] = serverTokenFile;
  }

  const tokenFile = options.tokenFile as string | undefined;
  if (tokenFile) {
    env["SWAMP_WORKER_TOKEN_FILE"] = tokenFile;
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

  const concurrency = options.concurrency as string | undefined;
  if (concurrency !== undefined) {
    env["SWAMP_WORKER_CONCURRENCY"] = concurrency;
  }

  const caCert = options.caCert as string | undefined;
  if (caCert) {
    env["SWAMP_CA_CERT"] = caCert;
  }

  const extraHeaders = options.extraHeaders as string | undefined;
  if (extraHeaders) {
    env["SWAMP_SERVE_EXTRA_HEADERS"] = extraHeaders;
  }

  return env;
}

export const workerDaemonEnableCommand = new Command()
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
    "--token-file <path:string>",
    "Path to a file containing the enrollment token; mutually exclusive with --token",
  )
  .option(
    "--server-token <token:string>",
    "Server access token for authenticating the WebSocket connection (<name>.<secret>)",
  )
  .option(
    "--server-token-file <path:string>",
    "Path to a file containing the server access token; mutually exclusive with --server-token",
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
  .option(
    "--concurrency <n:string>",
    'Number of concurrent dispatch slots ("auto" = CPU count of the machine running the service, min 1). Default: 1',
  )
  .option(
    "--ca-cert <path:string>",
    "Path to PEM-encoded CA certificate to trust for TLS connections to the orchestrator; a system service must be able to read it",
  )
  .example(
    "Enable worker daemon",
    "swamp worker daemon enable wss://orch:9090 --token tok.secret --label tier=ci --cache-dir /var/lib/swamp-worker",
  )
  .example(
    "Enable with secrets from a Kubernetes Secret mount",
    "swamp worker daemon enable wss://orch:9090 --token-file /tokens/worker-token --server-token-file /tokens/server-token --label tier=ci",
  )
  .example(
    "Enable with a token-authenticated orchestrator",
    "swamp worker daemon enable wss://orch:9090 --token tok.secret --server-token admin.secret --label tier=ci",
  )
  .example(
    "Enable with lifecycle policies",
    "swamp worker daemon enable wss://orch:9090 --token tok.secret --max-dispatches 100 --idle-timeout 30m",
  )
  .example(
    "Enable against an orchestrator with a private-CA certificate",
    "swamp worker daemon enable wss://orch.internal:9090 --token-file /etc/swamp/worker-token --ca-cert /etc/swamp/ca.pem --concurrency auto",
  )
  .example(
    "Enable through a reverse-proxy that requires a tunnel token",
    "SWAMP_SERVE_EXTRA_HEADERS=$'Tunnel-Token: abc123' swamp worker daemon enable wss://orch.internal:9090 --token tok.secret",
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
    if (options.token && options.tokenFile) {
      throw new UserError(
        "--token and --token-file are mutually exclusive",
      );
    }
    if (options.serverToken && options.serverTokenFile) {
      throw new UserError(
        "--server-token and --server-token-file are mutually exclusive",
      );
    }
    if (!options.token && !options.tokenFile) {
      throw new UserError(
        "Missing enrollment token — pass --token or --token-file:\n\n" +
          "  swamp worker daemon enable wss://orchestrator:9090 --token <name>.<secret>",
      );
    }
    validateWorkerDaemonOptions(urlArg, options);

    // The service runs from the cache dir (or /), so a path relative to the
    // shell that ran `daemon enable` must be made absolute here.
    let tokenFile: string | undefined;
    if (options.tokenFile) {
      tokenFile = resolve(options.tokenFile as string);
      await readTokenFile(tokenFile, "--token-file");
    }
    let serverTokenFile: string | undefined;
    if (options.serverTokenFile) {
      serverTokenFile = resolve(options.serverTokenFile as string);
      await readTokenFile(serverTokenFile, "--server-token-file");
    }

    let cacheDir: string | undefined;
    if (options.cacheDir) {
      cacheDir = await validateCacheDir(options.cacheDir as string);
    }

    let caCert: string | undefined;
    if (options.caCert) {
      caCert = await validateCaCertFile(options.caCert as string);
    }

    const extraHeaders = captureExtraHeaders();

    const resolvedOptions = {
      ...options,
      url: urlArg,
      tokenFile,
      serverTokenFile,
      cacheDir,
      caCert,
      extraHeaders: extraHeaders?.raw,
    };
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createWorkerDaemonScheduler({ mode });
    const extraArgs = collectWorkerExtraArgs(options);
    const env = {
      ...workerDaemonBaseEnv(),
      ...collectWorkerEnv(resolvedOptions),
    };

    await scheduler.enable({
      binaryPath: Deno.execPath(),
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      cacheDir,
    });

    renderWorkerDaemonEnabled(
      ctx.outputMode,
      toServiceMode(mode),
      extraHeaders?.names,
    );
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
  .command("enable", workerDaemonEnableCommand)
  .command("disable", daemonDisableCommand)
  .command("status", daemonStatusCommand);
