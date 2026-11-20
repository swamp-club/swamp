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
import { resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
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
import { HostConfig } from "../../serve/host/host_config.ts";
import {
  type HostLayout,
  locateHostYaml,
} from "../../serve/host/host_layout.ts";
import { type ServeHost, startServeHost } from "../../serve/host/serve_host.ts";
import {
  hostConfiguredParent,
  hostWorkspaceStore,
} from "../../serve/host/workspace_registration.ts";
import { reloadsOnHangup } from "../../serve/reload_on_hangup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveHostCommand = new Command()
  .name("host")
  .hidden()
  .description(
    "Run one serve per workspace behind a single address.\n\n" +
      "host.yaml holds the listener, its TLS certificate, the public address and an optional root repo. The host runs in one of two layouts:\n" +
      "  - A host folder, given with --host-dir or the current folder when it holds host.yaml and is not the config dir: host.yaml, and workspaces/ holding one swamp repo per workspace made there plus the state files. Workspace folders added or removed while the host runs are picked up.\n" +
      "  - No host folder, otherwise: <config dir>/host.yaml, with the state files in <data dir>/host/, which holds no repo. Its workspaces are the repos registered with swamp workspace import or swamp workspace create, and a request cannot create one.\n" +
      "Relative paths in host.yaml are taken from the folder that holds it. The host logs which host.yaml it read. One host runs per state folder: a second exits naming it.\n\n" +
      "Every workspace in the user's workspace registry is listed. Each answers at <address>/w/<name>; the root answers at the address itself. A workspace's serve starts only when its <name>.wanted.yaml in the state folder says wanted: active; the root starts with the host. The host has no repo of its own and authenticates no one: each workspace's serve does.\n\n" +
      "host.yaml can name one OAuth client (oauth-client: id and secret-file, a path outside every repo the host runs). The root and every workspace are started with it through --oauth-client-id and --oauth-client-secret-file, so a workspace in oauth mode needs no client of its own. " +
      "It replaces a root's own client, so links the root made under that client are no longer found. " +
      "A workspace's first start still looks up its admins and allowed users; it does so unattended only with SWAMP_API_KEY or SWAMP_API_KEY_FILE in the host's environment, and otherwise needs one device grant.\n\n" +
      "The host is one trust domain, as plain serve is: every workspace's models see the host's whole environment, cloud credentials included, so host only workspaces whose teams trust each other and the host's operator. " +
      "Serve settings in the environment (SWAMP_GRANTS_FILE, SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT and the rest) are not passed on: each workspace's serve settings come from its own repo.",
  )
  .option(
    "--host-dir <dir:string>",
    "The host folder holding host.yaml and workspaces/ (default: the current directory when it holds host.yaml and is not the config dir, otherwise no host folder and the config dir's host.yaml)",
  )
  .example(
    "Run the host in the current folder",
    "swamp serve host",
  )
  .example(
    "Run the host in another folder and print the listening line as JSON",
    "swamp serve host --host-dir /srv/swamp-host --json",
  )
  .example(
    "Run a host with no host folder, from host.yaml in the config dir",
    "cd ~ && swamp serve host",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve", "host"]);
    const renderer = createServeHostRenderer(ctx.outputMode);
    const { layout, text } = await locateHostConfig(
      options.hostDir as string | undefined,
    );
    ctx.logger.info(
      layout.hostFolder === null
        ? "Read {file}; the host has no host folder and keeps its state in {state}"
        : "Read {file}; the host folder is {folder}",
      {
        file: layout.configFile,
        folder: layout.hostFolder,
        state: layout.stateDir,
      },
    );
    const config = HostConfig.parse(text, layout);
    const hostEnv = Deno.env.toObject();
    for (const name of withheldServeSettings(hostEnv)) {
      ctx.logger.warn(
        "{name} is set but not passed to any workspace's serve: each workspace's serve settings come from its own repo, such as its .swamp/serve.yaml",
        { name },
      );
    }

    // the children are pinned to the same two folders, so the root writes the same registry
    const swampHome = resolve(getSwampDataDir());
    const configDir = resolve(getSwampConfigDir());
    const host = await startServeHost({
      config,
      processPort: DENO_SERVE_PROCESS_PORT,
      childEnv: hostChildEnv(hostEnv, {
        swampHome,
        configDir,
        cwd: Deno.cwd(),
      }),
      workspaceStore: hostWorkspaceStore({ dataDir: swampHome, configDir }),
      configuredParent: hostConfiguredParent(configDir),
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

/** the swamp dirs are read here, so the host and the children it pins to them agree */
export async function locateHostConfig(
  hostDir: string | undefined,
): Promise<{ layout: HostLayout; text: string }> {
  return await locateHostYaml({
    ...(hostDir === undefined ? {} : { hostDir }),
    cwd: Deno.cwd(),
    configDir: resolve(getSwampConfigDir()),
    dataDir: resolve(getSwampDataDir()),
  });
}
