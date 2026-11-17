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
import { join, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  getSwampConfigDir,
  getSwampDataDir,
} from "../../infrastructure/persistence/paths.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { createServeHostRenderer } from "../../presentation/renderers/serve_host.ts";
import {
  hostChildEnv,
  withheldServeSettings,
} from "../../serve/host/child_env.ts";
import { DENO_SERVE_PROCESS_PORT } from "../../serve/host/deno_serve_process.ts";
import { HOST_CONFIG_FILE, HostConfig } from "../../serve/host/host_config.ts";
import { type ServeHost, startServeHost } from "../../serve/host/serve_host.ts";
import { reloadsOnHangup } from "../../serve/reload_on_hangup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveHostCommand = new Command()
  .name("host")
  .hidden()
  .description(
    "Run one serve per workspace behind a single address.\n\n" +
      "Runs in a host folder holding host.yaml (the listener, its TLS certificate, the public address and an optional root repo) " +
      "and workspaces/<name>/, one swamp repo per hosted workspace. Each workspace answers at <address>/w/<name>; the root answers at the address itself. " +
      "Workspace folders added or removed while the host runs are picked up. The host has no repo of its own and authenticates no one: each workspace's serve does.",
  )
  .option(
    "--host-dir <dir:string>",
    "The host folder holding host.yaml and workspaces/ (default: the current directory)",
  )
  .example(
    "Run the host in the current folder",
    "swamp serve host",
  )
  .example(
    "Run the host in another folder and print the listening line as JSON",
    "swamp serve host --host-dir /srv/swamp-host --json",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve", "host"]);
    const renderer = createServeHostRenderer(ctx.outputMode);
    const hostDir = resolve((options.hostDir as string | undefined) ?? ".");
    const config = HostConfig.parse(await readHostYaml(hostDir), hostDir);
    const hostEnv = Deno.env.toObject();
    for (const name of withheldServeSettings(hostEnv)) {
      ctx.logger.warn(
        "{name} is set but not passed to any workspace's serve, since it names one serve's setting; each workspace sets its own in its repo, such as in .swamp/serve.yaml",
        { name },
      );
    }

    const host = await startServeHost({
      config,
      processPort: DENO_SERVE_PROCESS_PORT,
      childEnv: hostChildEnv(hostEnv, {
        swampHome: resolve(getSwampDataDir()),
        configDir: resolve(getSwampConfigDir()),
        cwd: Deno.cwd(),
      }),
      onWorkspaceChange: (change) => renderer.workspacesChanged(change),
    });

    renderer.listening({
      host: host.hostname,
      port: host.port,
      url: listeningUrl(config.protocol, host.hostname, host.port),
      address: config.address,
      root: config.root !== null,
      workspaces: host.workspaces.length,
    });
    await serveUntilStopped(host, PROCESS_STOP_SIGNALS);
    renderer.stopped();
  });

export function listeningUrl(
  protocol: string,
  hostname: string,
  port: number,
): string {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${protocol}://${host}:${port}`;
}

export interface StopSignals {
  /** the returned function unregisters the listener */
  onStop(listener: () => void): () => void;
  /** the returned function unregisters the listener */
  onReload(listener: () => void): () => void;
}

// SIGHUP reloads where it reloads plain serve; at a terminal it is a hangup
function hangupReloads(): boolean {
  return reloadsOnHangup({
    os: Deno.build.os,
    hotReload: false,
    stdinIsTerminal: Deno.stdin.isTerminal(),
  });
}

function addPosixListener(
  signal: Deno.Signal,
  listener: () => void,
): () => void {
  Deno.addSignalListener(signal, listener);
  return () => {
    try {
      Deno.removeSignalListener(signal, listener);
    } catch {
      // already removed
    }
  };
}

// a second Ctrl+C exits at once
export const PROCESS_STOP_SIGNALS: StopSignals = {
  onStop(listener) {
    const handle = registerShutdownHandler({
      handler: listener,
      includePosixSignals: Deno.build.os === "windows",
      forceExitOnRepeat: true,
    });
    const removers: Array<() => void> = [];
    if (Deno.build.os !== "windows") {
      removers.push(addPosixListener("SIGTERM", listener));
      if (!hangupReloads()) removers.push(addPosixListener("SIGHUP", listener));
    }
    return () => {
      handle.dispose();
      for (const remove of removers) remove();
    };
  },
  onReload(listener) {
    if (!hangupReloads()) return () => {};
    return addPosixListener("SIGHUP", listener);
  },
};

/**
 * the stop signals stay registered through the drain, so a second Ctrl+C
 * still ends a host whose children are slow to stop
 */
export async function serveUntilStopped(
  host: Pick<ServeHost, "reload" | "shutdown" | "finished">,
  signals: StopSignals,
): Promise<void> {
  const { promise: stopRequested, resolve: requestStop } = Promise
    .withResolvers<void>();
  let stopping = false;
  // held through the drain, so a SIGHUP then is ignored rather than fatal
  const unregisterReload = signals.onReload(() => {
    if (!stopping) host.reload();
  });
  const unregister = signals.onStop(() => requestStop());
  try {
    await Promise.race([stopRequested, host.finished]);
  } finally {
    stopping = true;
    try {
      await host.shutdown();
    } finally {
      unregister();
      unregisterReload();
    }
  }
}

export async function readHostYaml(hostDir: string): Promise<string> {
  const path = join(hostDir, HOST_CONFIG_FILE);
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw markErrorPaths(
        new UserError(
          `No ${HOST_CONFIG_FILE} in ${hostDir}. Run swamp serve host in a host folder, or pass --host-dir. A ${HOST_CONFIG_FILE} needs at least the public address, such as address: https://serve.example.com`,
        ),
        [hostDir],
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw markErrorPaths(
      new UserError(`Cannot read ${path}: ${reason}`),
      [path],
    );
  }
}
