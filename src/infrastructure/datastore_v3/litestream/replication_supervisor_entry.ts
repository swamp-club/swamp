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
 * main.ts calls runSupervisorMain first when started with the supervisor
 * marker, so no CLI command, auth gate, telemetry or extension loading runs
 */

import { defaultLitestreamBinaryProvider } from "./litestream_binary_provider.ts";
import { verifyReplica } from "./replica_verifier.ts";
import { readNewestSnapshotTxid } from "./replica_snapshot.ts";
import { litestreamChildEnv } from "./sidecar_env.ts";
import {
  type LitestreamChild,
  parseSupervisorArgs,
  runReplicationSupervisor,
  type SupervisorDeps,
} from "./replication_supervisor.ts";

export { isSupervisorInvocation } from "./litestream_processes.ts";

export function hostSupervisorDeps(
  stopRequested: Promise<void>,
): SupervisorDeps {
  const resolveBinary = async () =>
    (await defaultLitestreamBinaryProvider().resolve()).path;
  return {
    resolveBinary,
    startLitestream(binary, configPath, replicaType): LitestreamChild {
      const child = new Deno.Command(binary, {
        // Paths in the config are taken literally, never expanded.
        args: ["replicate", "-config", configPath, "-no-expand-env"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
        // only what its replica needs; the supervisor keeps its own environment
        ...(replicaType !== undefined
          ? {
            env: litestreamChildEnv(replicaType, Deno.env.toObject()),
            clearEnv: true,
          }
          : {}),
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
    async verifyReplica(request) {
      return await verifyReplica({
        ...request,
        binary: await resolveBinary(),
        now: () => Date.now(),
      });
    },
    async readSnapshotTxid(request) {
      return await readNewestSnapshotTxid({
        binary: await resolveBinary(),
        // The sidecar's own config names `commits.db` and its replica; the
        // listing never opens the database.
        config: request.paths.config,
        source: request.paths.commitsDb,
        replicaType: request.replicaType,
        signal: request.signal,
      });
    },
  };
}

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
