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
import { UserError } from "../../domain/errors.ts";
import {
  getSwampConfigDir,
  getSwampDataDir,
} from "../../infrastructure/persistence/paths.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { createServeHostRenderer } from "../../presentation/renderers/serve_host.ts";
import { hostChildEnv } from "../../serve/host/child_env.ts";
import { DENO_SERVE_PROCESS_PORT } from "../../serve/host/deno_serve_process.ts";
import { HOST_CONFIG_FILE, HostConfig } from "../../serve/host/host_config.ts";
import { startServeHost } from "../../serve/host/serve_host.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const serveHostCommand = new Command()
  .name("host")
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

    const host = await startServeHost({
      config,
      processPort: DENO_SERVE_PROCESS_PORT,
      childEnv: hostChildEnv(Deno.env.toObject(), {
        swampHome: resolve(getSwampDataDir()),
        configDir: resolve(getSwampConfigDir()),
      }),
      onWorkspaceChange: (change) => renderer.workspacesChanged(change),
    });

    const { promise: stopRequested, resolve: requestStop } = Promise
      .withResolvers<void>();
    // SIGHUP is left alone, as serve leaves it for reload; a second Ctrl+C exits at once
    const handle = registerShutdownHandler({
      handler: () => requestStop(),
      includePosixSignals: Deno.build.os === "windows",
      forceExitOnRepeat: true,
    });
    const onSigterm = () => requestStop();
    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGTERM", onSigterm);
    }
    try {
      renderer.listening({
        host: host.hostname,
        port: host.port,
        url: `${config.protocol}://${host.hostname}:${host.port}`,
        address: config.address,
        root: config.root !== null,
        workspaces: host.workspaces.length,
      });
      await Promise.race([stopRequested, host.finished]);
    } finally {
      handle.dispose();
      if (Deno.build.os !== "windows") {
        try {
          Deno.removeSignalListener("SIGTERM", onSigterm);
        } catch {
          // already removed
        }
      }
      await host.shutdown();
    }
    renderer.stopped();
  });

async function readHostYaml(hostDir: string): Promise<string> {
  const path = join(hostDir, HOST_CONFIG_FILE);
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new UserError(
        `No ${HOST_CONFIG_FILE} in ${hostDir}. Run swamp serve host in a host folder, or pass --host-dir.`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new UserError(`Cannot read ${path}: ${reason}`);
  }
}
