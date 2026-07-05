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
import { UserError } from "../../domain/errors.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkerVerifyResponse } from "../../serve/protocol.ts";
import { renderWorkerVerify } from "../../presentation/output/worker_output.ts";

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

export const workerVerifyCommand = withRemoteOptions(
  new Command()
    .name("verify")
    .description(
      "Run a fleet probe on connected workers to verify enrollment, scheduling, capability RPC, and data plane connectivity",
    )
    .example("Verify all workers", "swamp worker verify")
    .example("Verify one worker by name", "swamp worker verify my-worker")
    .example(
      "Verify workers with a label selector",
      "swamp worker verify --label gpu=true",
    )
    .arguments("[name:string]")
    .option(
      "--label <label:string>",
      "Filter workers by label key=value (repeatable)",
      { collect: true },
    ),
).action(async function (options: AnyOptions, name?: string) {
  const cliCtx = createContext(options as GlobalOptions, [
    "worker",
    "verify",
  ]);

  const server = resolveServeUrl(options.server as string | undefined);
  if (!server) {
    throw new UserError(
      "Worker verify requires a running orchestrator — pass --server or set SWAMP_SERVE_URL",
    );
  }

  const token = await resolveServerToken(
    server,
    options.token as string | undefined,
  );
  const labels = parseLabels(options.label);
  const response = await requestServerResponse<WorkerVerifyResponse>(
    { server, token, timeoutMs: 120_000 },
    {
      type: "worker.verify",
      payload: {
        workerName: name,
        labels: Object.keys(labels).length > 0 ? labels : undefined,
      },
    },
  );
  const data = response.data as unknown as WorkerVerifyData;
  renderWorkerVerify(data, cliCtx.outputMode);
  if (data.failed > 0) {
    Deno.exitCode = 1;
  }
});

export interface WorkerVerifyData {
  workers: WorkerProbeResult[];
  total: number;
  passed: number;
  failed: number;
}

export interface WorkerProbeResult {
  name: string;
  status: "pass" | "fail" | "error";
  platform?: string;
  arch?: string;
  probeMarkerOk?: boolean;
  queryOk?: boolean;
  dataPlaneOk?: boolean;
  failures?: string[];
  error?: string;
}
