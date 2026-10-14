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
 * Runs a replication supervisor process (swamp-club#3416). `main.ts` calls
 * {@link runSupervisorMain} as its first statement when it is started with
 * the supervisor marker, so no CLI command, auth gate, telemetry or
 * extension loading runs; from source, `deno run` starts this file
 * directly.
 *
 * @module
 */

import { defaultLitestreamBinaryProvider } from "./litestream_binary_provider.ts";
import {
  type LitestreamChild,
  parseSupervisorArgs,
  runReplicationSupervisor,
  type SupervisorDeps,
} from "./replication_supervisor.ts";

export { isSupervisorInvocation } from "./litestream_processes.ts";

/** The supervisor's real dependencies. */
export function hostSupervisorDeps(
  stopRequested: Promise<void>,
): SupervisorDeps {
  return {
    async resolveBinary() {
      return (await defaultLitestreamBinaryProvider().resolve()).path;
    },
    startLitestream(binary, configPath): LitestreamChild {
      const child = new Deno.Command(binary, {
        // Paths in the config are taken literally, never expanded.
        args: ["replicate", "-config", configPath, "-no-expand-env"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      return {
        pid: child.pid,
        exited: child.status,
        kill(signal) {
          try {
            child.kill(signal);
          } catch {
            // Exited already.
          }
        },
      };
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    stopRequested,
  };
}

/**
 * Runs the supervisor `args` describe and resolves with its exit code: 0
 * when it ended normally (another supervisor runs, idle, Litestream exited,
 * or asked to stop), 2 for arguments that are not a supervisor's, 1 on a
 * failure.
 */
export async function runSupervisorMain(
  args: readonly string[],
): Promise<number> {
  const options = parseSupervisorArgs(args);
  if (options === undefined) return 2;
  const stopRequested = new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      Deno.addSignalListener(signal, () => resolve());
    }
  });
  try {
    await runReplicationSupervisor(options, hostSupervisorDeps(stopRequested));
    return 0;
  } catch {
    // Detached, with nowhere to report: the next command finds no sidecar
    // and starts one, or reports why it cannot.
    return 1;
  }
}

if (import.meta.main) {
  Deno.exit(await runSupervisorMain(Deno.args));
}
