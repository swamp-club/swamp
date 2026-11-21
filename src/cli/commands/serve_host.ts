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
import {
  resolveRootWorkspace,
  ROOT_WORKSPACE_NAME,
  rootWorkspaceLocation,
  SERVE_CONFIG_PATH,
} from "../../serve/host/root_workspace.ts";
import { type ServeHost, startServeHost } from "../../serve/host/serve_host.ts";
import { childRootWorkspaceCreator } from "../../serve/root_workspace_process.ts";
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
      "<config dir>/host.yaml holds the listener, its TLS certificate, the public address and an optional root repo; relative paths in it are taken from the config dir. " +
      "The root is the serve at the address itself, which swamp serve workspace commands talk to and which issues sign-in codes. With no root: in host.yaml, the host uses its root workspace host-root, an ordinary workspace it makes with swamp workspace create on its first start and finds again by its registry entry; it is never listed among the workspaces. " +
      "The root workspace takes its auth from its own .swamp/serve.yaml, as plain swamp serve does, so while serve's default is auth mode none anyone on this machine can create, resume and delete workspaces through it and run code as the host's user; set auth.mode there to change that. Off loopback or behind a proxy a root in auth mode none is refused. " +
      "With no host.yaml there, the first run creates one listening on 127.0.0.1:8080 with address http://127.0.0.1:8080, the other keys written as comments, and starts from it; it never replaces an existing host.yaml, even an invalid one. " +
      "The host keeps its state files in <data dir>/host/, which holds no repo. The host logs which host.yaml it read. One host runs per state folder: a second exits naming it.\n\n" +
      "Every workspace in the user's workspace registry is listed, as swamp workspace import or swamp workspace create registered it; a request creates one where swamp workspace create would, in workspaces.dir or <data dir>/workspaces. Each answers at <address>/w/<name>; the root answers at the address itself. A workspace's serve starts only when its <name>.wanted.yaml in the state folder says wanted: active; the root starts with the host. The host has no repo of its own and authenticates no one: each workspace's serve does.\n\n" +
      "host.yaml can name one OAuth client (oauth-client: id and secret-file, a path outside every repo the host runs). The root and every workspace are started with it through --oauth-client-id and --oauth-client-secret-file, so a workspace in oauth mode needs no client of its own. " +
      "It replaces a root's own client, so links the root made under that client are no longer found. " +
      "A workspace's first start still looks up its admins and allowed users; it does so unattended only with SWAMP_API_KEY or SWAMP_API_KEY_FILE in the host's environment, and otherwise needs one device grant.\n\n" +
      "The host is one trust domain, as plain serve is: every workspace's models see the host's whole environment, cloud credentials included, so host only workspaces whose teams trust each other and the host's operator. " +
      "Serve settings in the environment (SWAMP_GRANTS_FILE, SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT and the rest) are not passed on: each workspace's serve settings come from its own repo.",
  )
  .example(
    "Run the host from host.yaml in the config dir, which the first run creates",
    "swamp serve host",
  )
  .example(
    "Run the host and print the listening line as JSON",
    "swamp serve host --json",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve", "host"]);
    const renderer = createServeHostRenderer(ctx.outputMode);
    const { layout, text, created } = await locateHostConfig();
    if (created) {
      renderer.created({
        file: layout.configFile,
        rootWorkspace: ROOT_WORKSPACE_NAME,
      });
    }
    ctx.logger.info("Read {file}; the host keeps its state in {state}", {
      file: layout.configFile,
      state: layout.stateDir,
    });
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
    const childEnv = hostChildEnv(hostEnv, {
      swampHome,
      configDir,
      cwd: Deno.cwd(),
    });
    const workspaceStore = hostWorkspaceStore({
      dataDir: swampHome,
      configDir,
    });
    const configuredParent = hostConfiguredParent(configDir);
    const host = await startServeHost({
      config,
      processPort: DENO_SERVE_PROCESS_PORT,
      childEnv,
      workspaceStore,
      configuredParent,
      rootWorkspace: () =>
        resolveRootWorkspace({
          stateDir: config.stateDir,
          store: workspaceStore,
          location: rootWorkspaceLocation({
            dataDir: swampHome,
            configuredParent,
          }),
          creator: childRootWorkspaceCreator({ env: childEnv, cwd: swampHome }),
        }),
      onWorkspaceChange: (change) => renderer.workspacesChanged(change),
    });
    if (host.rootWorkspace !== null) {
      renderer.rootWorkspace({
        ...host.rootWorkspace,
        serveConfig: join(host.rootWorkspace.folder, SERVE_CONFIG_PATH),
      });
    }

    renderer.listening({
      host: host.hostname,
      port: host.port,
      url: listeningUrl(config.protocol, host.hostname, host.port),
      address: config.address,
      root: config.root !== null || host.rootWorkspace !== null,
      rootWorkspace: host.rootWorkspace?.name ?? null,
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
export async function locateHostConfig(): Promise<
  { layout: HostLayout; text: string; created: boolean }
> {
  return await locateHostYaml({
    configDir: resolve(getSwampConfigDir()),
    dataDir: resolve(getSwampDataDir()),
  });
}
