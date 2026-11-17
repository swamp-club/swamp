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
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  readProcessCommand,
  readProcessStartTime,
} from "../../infrastructure/process/process_kill.ts";
import {
  probeServePid,
  processExists,
  readServePidSidecar,
} from "../../serve/serve_pid_file.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  CA_CERT_DESCRIPTION,
  CA_CERT_FLAG,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  TOKEN_FILE_DESCRIPTION,
} from "../remote_run.ts";
import { validateServerRepoExclusivity } from "./access_helpers.ts";
import type { ServeReloadResponse } from "../../serve/protocol.ts";
import { createServeReloadRenderer } from "../../presentation/renderers/serve_reload.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

export const reloadCommand = new Command()
  .name("reload")
  .description(
    "Reload a running serve process: extensions, the trust list, and every serve.yaml setting that can change without a restart, reported setting by setting.\n\n" +
      "With --server, sends a reload request to the running server over WebSocket (admin only). " +
      "Without --server, reads .swamp/serve.pid and sends SIGHUP locally; a serve writes that file when it is not attached to a terminal (a daemon, container or service) or was started with --hot-reload.",
  )
  .example(
    "Reload on a remote server",
    "swamp serve reload --server wss://swamp.acme.internal:9090",
  )
  .example("Reload locally", "swamp serve reload")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--server <url:string>",
    "Reload extensions on a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token; only applies with --server (falls back to stored credential or SWAMP_SERVER_TOKEN)",
  )
  .option(
    "--token-file <path:string>",
    TOKEN_FILE_DESCRIPTION,
  )
  .option(CA_CERT_FLAG, CA_CERT_DESCRIPTION)
  .action(async function (options: AnyOptions) {
    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    const ctx = createContext(options as GlobalOptions, ["serve", "reload"]);
    const renderer = createServeReloadRenderer(ctx.outputMode);

    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );

      const response = await requestServerResponse<ServeReloadResponse>(
        { server, ...(token ? { token } : {}) },
        { type: "serve.reload" },
      );

      if (!response.success) {
        renderer.render({
          success: false,
          reloadedCount: 0,
          errors: response.errors,
        });
        throw new UserError("Extension reload failed on the server");
      }

      renderer.render(response);
      // a CI step that edits serve.yaml and reloads must see the refusal
      if (response.configRejected) {
        throw new UserError(
          "The server refused serve.yaml, so nothing in it was applied",
        );
      }
      return;
    }

    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const pidPath = swampPath(repoDir, "serve.pid");

    let pidStr: string;
    try {
      pidStr = await Deno.readTextFile(pidPath);
    } catch {
      throw markErrorPaths(
        new UserError(
          "No PID file found at " + pidPath + ". " +
            "A serve running in a terminal reloads only over --server, or when started with --hot-reload.",
        ),
        [pidPath],
      );
    }

    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) {
      throw markErrorPaths(
        new UserError("Invalid PID in " + pidPath + ": " + pidStr.trim()),
        [pidPath],
      );
    }

    const verdict = await probeServePid(
      pid,
      await readServePidSidecar(pidPath),
      {
        processExists,
        startTime: (p) => readProcessStartTime(p),
        command: (p) => readProcessCommand(p),
      },
    );
    if (verdict === "gone") {
      throw markErrorPaths(
        new UserError(
          "Process " + pid + " is not running — stale PID file. " +
            "Remove " + pidPath + ", or reload with --server.",
        ),
        [pidPath],
      );
    }
    if (verdict === "reused") {
      throw markErrorPaths(
        new UserError(
          "Process " + pid + " is not the serve that wrote " + pidPath +
            ": it started at another time and is not a swamp serve — stale PID file. Remove it, or reload with --server.",
        ),
        [pidPath],
      );
    }
    if (verdict === "unknown") {
      logger
        .warn`Could not confirm process ${pid} is the serve that wrote ${pidPath} (an older serve records no start time, ps cannot report it, or the clock was changed since serve started); sending SIGHUP anyway`;
    }

    try {
      Deno.kill(pid, "SIGHUP");
    } catch {
      throw markErrorPaths(
        new UserError(
          "Process " + pid + " not found — stale PID file. " +
            "Remove " + pidPath + ", or reload with --server.",
        ),
        [pidPath],
      );
    }

    logger.info`Sent SIGHUP to serve process ${pid}`;
    logger
      .info`The serve log lists what the reload applied; reload with --server to see it here`;
  });
