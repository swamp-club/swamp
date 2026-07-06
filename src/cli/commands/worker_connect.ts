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
import { parseLabels } from "./worker_shared.ts";
import { runWorker, type WorkerExitReason } from "../../worker/connect.ts";
import { renderWorkerStatus } from "../../presentation/output/worker_output.ts";
import { VERSION } from "./version.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { parseTimeout } from "../duration_parser.ts";
import { resolveExtraHeaders } from "../../domain/auth/extra_headers.ts";

// Import models barrel so built-in models resolve from the worker's own
// registry when a `builtin:` bundle fingerprint is dispatched.
import "../../domain/models/models.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function parseCommaSeparatedLabels(envValue: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of envValue.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new UserError(
        `Invalid label '${trimmed}' in SWAMP_WORKER_LABELS — expected the form key=value`,
      );
    }
    labels[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
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
  .example(
    "Survive restarts on one token (stable machine identity)",
    "swamp worker connect wss://orch:4000 --token <token> --cache-dir /var/lib/swamp-worker",
  )
  .example(
    "Connect using environment variables only (containers, cloud-init)",
    "SWAMP_ORCHESTRATOR_URL=wss://orch:4000 SWAMP_WORKER_TOKEN=tok.secret swamp worker connect",
  )
  .example(
    "Exit after one dispatch (batch/CI mode)",
    "swamp worker connect wss://orch:4000 --token <token> --max-dispatches 1",
  )
  .example(
    "Auto-shutdown after 5 minutes of inactivity",
    "swamp worker connect wss://orch:4000 --token <token> --idle-timeout 5m",
  )
  .example(
    "Run up to one dispatch per CPU core",
    "swamp worker connect wss://orch:4000 --token <token> --concurrency auto",
  )
  .example(
    "Connect through a reverse-proxy that requires a tunnel token",
    "SWAMP_SERVE_EXTRA_HEADERS=$'Tunnel-Token: abc123' swamp worker connect wss://orch.internal:4000 --token tok.secret",
  )
  .arguments("[url:string]")
  .option(
    "--token <token:string>",
    "Enrollment token (<name>.<secret>) (env: SWAMP_WORKER_TOKEN)",
  )
  .option(
    "--label <label:string>",
    "Scheduling label key=value (repeatable) (env: SWAMP_WORKER_LABELS, comma-separated)",
    { collect: true },
  )
  .option(
    "--data-plane-url <url:string>",
    "Override the data-plane base URL (defaults to the connect URL over HTTP)",
  )
  .option(
    "--cache-dir <dir:string>",
    "Bundle/asset cache directory; also stores the machine id the enrollment token binds to — set a stable directory so the worker can re-enroll after a restart (defaults to a fresh temp dir) (env: SWAMP_WORKER_CACHE_DIR)",
  )
  .option("--no-reconnect", "Exit when the control socket closes")
  .option(
    "--max-dispatches <n:number>",
    "Drain and exit 0 after N dispatches complete (env: SWAMP_WORKER_MAX_DISPATCHES)",
  )
  .option(
    "--idle-timeout <duration:string>",
    "Drain and exit 0 after being continuously idle for this duration (e.g. 30s, 5m, 1h) (env: SWAMP_WORKER_IDLE_TIMEOUT)",
  )
  .option(
    "--concurrency <n:string>",
    'Number of concurrent dispatch slots ("auto" = CPU count, min 1). Default: 1 (env: SWAMP_WORKER_CONCURRENCY)',
  )
  .action(async function (options: AnyOptions, urlArg?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "worker",
      "connect",
    ]);

    const url = urlArg ?? Deno.env.get("SWAMP_ORCHESTRATOR_URL");
    if (url === undefined) {
      throw new UserError(
        "Missing orchestrator URL — pass it as a positional argument or set SWAMP_ORCHESTRATOR_URL",
      );
    }

    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      throw new UserError(
        `Orchestrator URL must start with ws:// or wss:// (got '${url}')`,
      );
    }

    const token = (options.token as string | undefined) ??
      Deno.env.get("SWAMP_WORKER_TOKEN");
    if (token === undefined) {
      throw new UserError(
        "Missing enrollment token — pass --token or set SWAMP_WORKER_TOKEN",
      );
    }

    const flagLabels = parseLabels(options.label);
    const envLabelsRaw = Deno.env.get("SWAMP_WORKER_LABELS");
    const envLabels = envLabelsRaw
      ? parseCommaSeparatedLabels(envLabelsRaw)
      : {};
    const labels = { ...envLabels, ...flagLabels };

    const cacheDir = (options.cacheDir as string | undefined) ??
      Deno.env.get("SWAMP_WORKER_CACHE_DIR");

    const maxDispatchesRaw = (options.maxDispatches as number | undefined) ??
      (() => {
        const env = Deno.env.get("SWAMP_WORKER_MAX_DISPATCHES");
        return env !== undefined ? Number(env) : undefined;
      })();
    if (
      maxDispatchesRaw !== undefined &&
      (isNaN(maxDispatchesRaw) || !Number.isInteger(maxDispatchesRaw) ||
        maxDispatchesRaw < 1)
    ) {
      throw new UserError(
        "--max-dispatches must be a positive integer",
      );
    }

    const idleTimeoutRaw = (options.idleTimeout as string | undefined) ??
      Deno.env.get("SWAMP_WORKER_IDLE_TIMEOUT");
    const idleTimeoutMs = idleTimeoutRaw !== undefined
      ? parseTimeout(idleTimeoutRaw, "--idle-timeout")
      : undefined;

    const concurrencyRaw = (options.concurrency as string | undefined) ??
      Deno.env.get("SWAMP_WORKER_CONCURRENCY");
    let concurrency = 1;
    if (concurrencyRaw !== undefined) {
      if (concurrencyRaw === "auto") {
        concurrency = Math.max(1, navigator.hardwareConcurrency ?? 1);
      } else {
        const parsed = Number(concurrencyRaw);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
          throw new UserError(
            '--concurrency must be a positive integer or "auto"',
          );
        }
        concurrency = parsed;
      }
    }

    let requestDrain: ((reason: WorkerExitReason) => void) | null = null;
    let signalCount = 0;
    const ac = new AbortController();
    const shutdownHandle = registerShutdownHandler({
      handler: () => {
        signalCount++;
        if (signalCount === 1 && requestDrain) {
          requestDrain("signal");
        } else if (signalCount === 1) {
          ac.abort();
        } else {
          Deno.exit(1);
        }
      },
    });

    try {
      const extraHeaders = resolveExtraHeaders();
      const result = await runWorker({
        url,
        token,
        labels,
        swampVersion: VERSION,
        dataPlaneUrl: options.dataPlaneUrl,
        cacheDir,
        headers: extraHeaders,
        reconnect: options.reconnect !== false,
        maxDispatches: maxDispatchesRaw,
        idleTimeoutMs,
        concurrency,
        signal: ac.signal,
        onStatus: (event) => {
          renderWorkerStatus(event, cliCtx.outputMode);
        },
        onDrainAvailable: (drain) => {
          requestDrain = drain;
        },
      });

      const policyComplete = result.reason !== "error";
      if (!policyComplete) {
        Deno.exit(1);
      }
    } catch (error) {
      throw new UserError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      shutdownHandle.dispose();
    }
  });
