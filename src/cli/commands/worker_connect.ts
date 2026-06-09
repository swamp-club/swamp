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

/**
 * `swamp worker connect` — the dial-home entry (see
 * design/remote-execution.md). Deliberately repo-less: a worker carries no
 * repository, datastore, vault, or extension state; it is a binary, a
 * token, and a URL. No RepositoryContext is constructed here.
 */

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";
import { runWorker } from "../../worker/connect.ts";
import { renderWorkerStatus } from "../../presentation/output/worker_output.ts";
import { VERSION } from "./version.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";

// Import models barrel so built-in models resolve from the worker's own
// registry when a `builtin:` bundle fingerprint is dispatched.
import "../../domain/models/models.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function parseLabels(labelFlags: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const flag of labelFlags ?? []) {
    const eq = flag.indexOf("=");
    if (eq <= 0 || eq === flag.length - 1) {
      throw new UserError(
        `Invalid label '${flag}' — expected the form key=value`,
      );
    }
    labels[flag.slice(0, eq)] = flag.slice(eq + 1);
  }
  return labels;
}

export const workerConnectCommand = new Command()
  .name("connect")
  .description(
    "Connect this machine to an orchestrator as a remote execution worker",
  )
  .example(
    "Dial home with a token",
    "swamp worker connect ws://orchestrator.internal:4000 --token <token>",
  )
  .example(
    "Advertise scheduling labels",
    "swamp worker connect wss://orch:4000 --token <token> --label region=us-east --label gpu=true",
  )
  .arguments("<url:string>")
  .option("--token <token:string>", "Enrollment token (<name>.<secret>)", {
    required: true,
  })
  .option(
    "--label <label:string>",
    "Scheduling label key=value (repeatable)",
    { collect: true },
  )
  .option(
    "--data-plane-url <url:string>",
    "Override the data-plane base URL (defaults to the connect URL over HTTP)",
  )
  .option(
    "--cache-dir <dir:string>",
    "Bundle/asset cache directory (defaults to a fresh temp dir)",
  )
  .option("--no-reconnect", "Exit when the control socket closes")
  .action(async function (options: AnyOptions, url: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "worker",
      "connect",
    ]);

    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      throw new UserError(
        `Orchestrator URL must start with ws:// or wss:// (got '${url}')`,
      );
    }

    const ac = new AbortController();
    registerShutdownHandler({
      handler: () => {
        ac.abort();
      },
    });

    try {
      await runWorker({
        url,
        token: options.token,
        labels: parseLabels(options.label),
        swampVersion: VERSION,
        dataPlaneUrl: options.dataPlaneUrl,
        cacheDir: options.cacheDir,
        reconnect: options.reconnect !== false,
        signal: ac.signal,
        onStatus: (event) => renderWorkerStatus(event, cliCtx.outputMode),
      });
    } catch (error) {
      throw new UserError(
        error instanceof Error ? error.message : String(error),
      );
    }
  });
