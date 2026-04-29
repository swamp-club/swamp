// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { initTelemetryService } from "../mod.ts";
import { HttpTelemetrySender } from "../../infrastructure/telemetry/http_telemetry_sender.ts";

/**
 * Flushes pending telemetry entries to the remote endpoint.
 *
 * The CLI's normal command path spawns this subcommand as a detached
 * child after a command completes, so the user doesn't pay the HTTP
 * round-trip on the foreground. Running it manually is also fine — the
 * subcommand reads the same persisted entries and ships whatever's
 * pending.
 */
export const telemetryFlushCommand = new Command()
  .name("flush")
  .description("Flush pending telemetry entries to the remote endpoint")
  .example("Flush manually", "swamp telemetry flush")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--timeout-ms <ms:number>",
    "HTTP timeout per flush attempt (default: 10000)",
    { default: 10_000 },
  )
  .action(async function (options) {
    const cliCtx = createContext(options as GlobalOptions, [
      "telemetry",
      "flush",
    ]);
    cliCtx.logger.debug("telemetry flush starting");

    const repoDir = resolveRepoDir(options.repoDir);
    const telemetryCtx = await initTelemetryService(repoDir);
    if (!telemetryCtx) {
      cliCtx.logger.debug("telemetry flush: no repo or telemetry disabled");
      return;
    }

    const sender = new HttpTelemetrySender(telemetryCtx.telemetryEndpoint);
    await telemetryCtx.service.flushTelemetry({
      sender,
      distinctId: telemetryCtx.userId ?? telemetryCtx.repoId,
      repoId: telemetryCtx.repoId,
      authToken: telemetryCtx.authToken ?? undefined,
      keepFlushed: telemetryCtx.keepFlushed,
      signal: AbortSignal.timeout(options.timeoutMs as number),
    });

    // Best-effort cleanup of old entries. Already fire-and-forget inside.
    telemetryCtx.service.cleanupOldTelemetry();

    cliCtx.logger.debug("telemetry flush complete");
  });
