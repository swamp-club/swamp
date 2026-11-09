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

import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  parseV3ReplicaSetting,
  replicaRootOf,
  V3_REPLICA_ENV,
} from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { lineageRegistryFor } from "../src/infrastructure/datastore_v3/litestream/v3_copy.ts";
import {
  currentLineage,
  newestStartedFence,
} from "../src/domain/datastore_v3/published_lineage.ts";
import {
  killSidecarAtTeardown,
  SIDECAR_TESTS_IGNORED,
} from "./datastore_v3_litestream_helpers.ts";
import type {
  MachineRequest,
  MachineResponse,
} from "./datastore_v3_litestream_machine_worker.ts";

export const ignore = SIDECAR_TESTS_IGNORED;

export const STALL_MS = 14_000;

// deno test has no per-test timeout, so this bounds a worker that never answers
const REQUEST_TIMEOUT_MS = 120_000;

// a worker that cannot report its sidecars by then is abandoned; they idle out
const TEARDOWN_PIDS_WAIT_MS = 5_000;

export interface Machine {
  send(
    request: MachineRequest,
    options?: { readonly timeoutMs?: number },
  ): Promise<unknown>;
  crash(): Promise<void>;
  stopSidecars(): Promise<void>;
}

export interface World {
  readonly root: string;
  readonly datastorePath: string;
  readonly replicaRoot: string;
  readonly replica: string;
  machine(
    name: string,
    options?: {
      readonly namespace?: string;
      readonly replica?: string;
      readonly checkout?: string;
      readonly gated?: boolean;
      readonly captureWarnings?: boolean;
      readonly lockTimeoutMs?: number;
      readonly binaryMissing?: boolean;
    },
  ): Promise<Machine>;
  lineages(): Promise<{ current?: number; newestStarted?: number }>;
  registered(fence: number): Promise<boolean>;
}

export class MachineError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

// each machine is a worker with its own module state, host name and checkout
export async function withMachines(
  fn: (world: World) => Promise<void>,
  options: { readonly replica?: (root: string) => string } = {},
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-ls-d2-" }),
  );
  const datastorePath = join(root, "ds");
  const replicaRoot = join(root, "replica");
  const privateRoot = join(root, "priv");
  const replica = options.replica?.(root) ??
    JSON.stringify({ type: "file", path: replicaRoot });
  await withMockedEnv(
    { [V3_REPLICA_ENV]: replica },
    () => initializeV3Datastore(datastorePath, "test"),
  );
  const workers: {
    worker: Worker;
    pids: () => Promise<number[]>;
    abandon: () => void;
  }[] = [];
  const pids = new Set<number>();
  const world: World = {
    root,
    datastorePath,
    replicaRoot,
    replica,
    async machine(name, machineOptions = {}) {
      const worker = new Worker(
        new URL("./datastore_v3_litestream_machine_worker.ts", import.meta.url),
        { type: "module" },
      );
      let queue: Promise<unknown> = Promise.resolve();
      let alive = true;
      // set once this worker is given up on: it is terminated, so no later
      // request can be answered
      let dead: Error | undefined;
      let failPending: ((error: Error) => void) | undefined;
      const call = (request: MachineRequest, timeoutMs: number) => {
        if (dead !== undefined) return Promise.reject(dead);
        const limit = timeoutMs + (request.kind === "pause" ? request.ms : 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        return new Promise<unknown>((done, fail) => {
          failPending = fail;
          timer = setTimeout(() => {
            dead = new Error(
              `machine-${name}: ${request.kind} did not answer within ${limit}ms`,
            );
            worker.terminate();
            fail(dead);
          }, limit);
          worker.onmessage = (event: MessageEvent<MachineResponse>) => {
            const response = event.data;
            if (response.ok) done(response.value);
            else fail(new MachineError(response.error, response.code));
          };
          worker.onerror = (event) => {
            event.preventDefault();
            fail(new Error(event.message));
          };
          worker.postMessage(request);
        }).finally(() => clearTimeout(timer));
      };
      const send = (
        request: MachineRequest,
        { timeoutMs = REQUEST_TIMEOUT_MS }: { readonly timeoutMs?: number } =
          {},
      ) => {
        const next = queue.then(() => call(request, timeoutMs));
        queue = next.catch(() => {});
        return next;
      };
      const abandon = () => {
        dead ??= new Error(`machine-${name}: abandoned at teardown`);
        failPending?.(dead);
      };
      const remember = async () => {
        if (!alive) return [];
        const launched = await send({ kind: "pids" }) as number[];
        for (const pid of launched) pids.add(pid);
        return launched;
      };
      workers.push({ worker, pids: remember, abandon });
      await send({
        kind: "init",
        hostname: `machine-${name}`,
        replica: machineOptions.replica ?? replica,
        privateRoot,
        datastorePath,
        repoDir: join(root, machineOptions.checkout ?? name),
        lockTimeoutMs: machineOptions.lockTimeoutMs ?? 30_000,
        ...(machineOptions.namespace !== undefined
          ? { namespace: machineOptions.namespace }
          : {}),
        ...(machineOptions.gated === true ? { gated: true } : {}),
        ...(machineOptions.captureWarnings === true
          ? { captureWarnings: true }
          : {}),
        ...(machineOptions.binaryMissing === true
          ? { binaryMissing: true }
          : {}),
      });
      return {
        send,
        async stopSidecars() {
          for (const pid of await remember()) {
            hostLitestreamProcesses.signalGroup(pid, "SIGKILL");
          }
          const launched = await remember();
          await waitFor(
            () =>
              launched.every((pid) => !hostLitestreamProcesses.isAlive(pid)),
            "the machine's sidecars to stop",
          );
        },
        async crash() {
          await remember();
          alive = false;
          worker.terminate();
        },
      };
    },
    async lineages() {
      return await withMockedEnv({ [V3_REPLICA_ENV]: replica }, async () => {
        const root = replicaRootOf(parseV3ReplicaSetting(replica));
        const read = await lineageRegistryFor(datastorePath).read(root);
        return {
          ...(currentLineage(read, root) !== undefined
            ? { current: currentLineage(read, root)!.fence }
            : {}),
          ...(newestStartedFence(read, root) !== undefined
            ? { newestStarted: newestStartedFence(read, root) }
            : {}),
        };
      });
    },
    async registered(fence) {
      return await withMockedEnv(
        { [V3_REPLICA_ENV]: replica },
        async () =>
          typeof await lineageRegistryFor(datastorePath).started(fence) ===
            "object",
      );
    },
  };
  try {
    await fn(world);
  } finally {
    for (const { worker, pids: remember, abandon } of workers) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        remember().catch(() => {}),
        new Promise((done) => {
          timer = setTimeout(done, TEARDOWN_PIDS_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      abandon();
      worker.terminate();
    }
    for (const pid of pids) killSidecarAtTeardown(pid);
    await waitFor(
      () => [...pids].every((pid) => !hostLitestreamProcesses.isAlive(pid)),
      "every sidecar to stop",
    );
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

export interface ReadResult {
  readonly commits: number;
  readonly restored: unknown;
}

export async function read(machine: Machine): Promise<ReadResult> {
  return await machine.send({ kind: "read" }) as ReadResult;
}

export async function closeGate(world: World, name: string): Promise<void> {
  await Deno.writeTextFile(join(world.root, name), "");
}

export async function gateEntered(world: World, name: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        await Deno.stat(join(world.root, `${name}.entered`));
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    `${name} to be reached`,
    { timeoutMs: 60_000 },
  );
}

export async function openGate(world: World, name: string): Promise<void> {
  await Deno.remove(join(world.root, name));
}

export const S3_ENDPOINT = Deno.env.get("SWAMP_TEST_LITESTREAM_S3_ENDPOINT");
