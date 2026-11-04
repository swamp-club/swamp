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
 * a worker with its own module state and host name, so another machine's lease
 * expires by TTL as a remote holder's does; `pause` blocks the thread like a
 * stalled process: lease renewals stop, the Litestream sidecar does not
 */

import { DatabaseSync } from "node:sqlite";
import { configure } from "@logtape/logtape";
import { dirname, join } from "@std/path";
import { LOCK_TIMEOUT_ENV_VAR } from "../src/domain/datastore/datastore_config.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  closeV3Datastores,
  confirmV3Replicated,
  ensureV3CopyCurrent,
  holdV3Writer,
  startV3ReplicationUpkeep,
  v3ClaimCommitLog,
  v3DatastoreFor,
  type V3ReplicationUpkeep,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  v3WriterFence,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import {
  v3CommitsDbPath,
  v3OutboxPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { replicationPathsFor } from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { createNamespaceListDeps } from "../src/libswamp/datastores/namespace_list.ts";
import { commitIn, TEST_TIMINGS } from "./datastore_v3_litestream_helpers.ts";
import { DatastoreOwner } from "../src/domain/datastore_v3/datastore_owner.ts";

export type MachineRequest =
  | {
    readonly kind: "init";
    readonly hostname: string;
    readonly replica: string;
    readonly privateRoot: string;
    readonly datastorePath: string;
    readonly repoDir: string;
    readonly lockTimeoutMs: number;
    readonly namespace?: string;
    /**
     * stalls the Litestream binary lookup while a gate file
     * `<hostname>-gate-restore` or `<hostname>-gate-sidecar` exists; each
     * writes `<gate>.entered` once it waits
     */
    readonly gated?: boolean;
    readonly captureWarnings?: boolean;
    readonly binaryMissing?: boolean;
  }
  | {
    readonly kind: "lease";
    readonly ttlMs: number;
    readonly retake?: boolean;
  }
  | {
    readonly kind: "write";
    readonly commits: number;
    readonly close: boolean;
  }
  | { readonly kind: "close" }
  | { readonly kind: "claim"; readonly address: string }
  | { readonly kind: "release" }
  | { readonly kind: "plantOutboxEntry" }
  | { readonly kind: "confirm" }
  | { readonly kind: "read" }
  | { readonly kind: "pause"; readonly ms: number }
  | { readonly kind: "upkeep"; readonly probeMs: number }
  | { readonly kind: "stopUpkeep" }
  | { readonly kind: "pids" }
  | { readonly kind: "files" }
  | { readonly kind: "catchUp" }
  | { readonly kind: "tryCommit" }
  | { readonly kind: "gc" }
  | { readonly kind: "restoreLock" }
  | { readonly kind: "namespaces" }
  | { readonly kind: "fence" }
  | { readonly kind: "count" }
  | { readonly kind: "readModel" }
  | { readonly kind: "warnings" };

export type MachineResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: string; readonly code?: string };

declare const self: Worker;

let init: Extract<MachineRequest, { kind: "init" }> | undefined;
let upkeep: V3ReplicationUpkeep | undefined;
let leaseRelease: (() => Promise<void>) | undefined;
const launched = new Set<number>();
const warnings: string[] = [];

function config(): FilesystemDatastoreConfig {
  return {
    type: "filesystem",
    path: init!.datastorePath,
    ...(init!.namespace !== undefined ? { namespace: init!.namespace } : {}),
  };
}

/**
 * This machine's environment, for the worker's whole life: its lease
 * renewals and serve's probes run after any one request has returned.
 */
function setEnvironment(overrides: Record<string, string>): void {
  const realGet = Deno.env.get.bind(Deno.env);
  const realHas = Deno.env.has.bind(Deno.env);
  const realToObject = Deno.env.toObject.bind(Deno.env);
  Object.defineProperty(Deno.env, "get", {
    configurable: true,
    value: (key: string) =>
      Object.hasOwn(overrides, key) ? overrides[key] : realGet(key),
  });
  Object.defineProperty(Deno.env, "has", {
    configurable: true,
    value: (key: string) => Object.hasOwn(overrides, key) || realHas(key),
  });
  Object.defineProperty(Deno.env, "toObject", {
    configurable: true,
    value: () => ({ ...realToObject(), ...overrides }),
  });
}

function inEnv<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function gatedBinary(
  request: Extract<MachineRequest, { kind: "init" }>,
): Promise<string> {
  // Deep enough to reach v3_copy.ts through the restore's spans.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 100;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const step = /v3_copy\.ts/.test(stack) ? "restore" : "sidecar";
  const gate = join(
    dirname(request.datastorePath),
    `${request.hostname}-gate-${step}`,
  );
  let entered = false;
  while (await exists(gate)) {
    if (!entered) {
      entered = true;
      await Deno.writeTextFile(`${gate}.entered`, "");
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return Deno.env.get("SWAMP_LITESTREAM_PATH")!;
}

function count(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as {
      n: number;
    }).n;
  } finally {
    db.close();
  }
}

async function handle(request: MachineRequest): Promise<unknown> {
  switch (request.kind) {
    case "init": {
      init = request;
      setEnvironment({
        [V3_REPLICA_ENV]: request.replica,
        [LOCK_TIMEOUT_ENV_VAR]: String(request.lockTimeoutMs),
      });
      // only the writer lease sees this machine's name, so another machine's
      // lease expires by TTL as a remote holder's does; the sidecar's
      // supervisor is a real local process its checks must still recognise
      const hostname = request.hostname;
      const realHostname = Deno.hostname.bind(Deno);
      Object.defineProperty(Deno, "hostname", {
        configurable: true,
        value: () =>
          /v3_writer_lock\.ts|writer_lease\.ts/.test(new Error().stack ?? "")
            ? hostname
            : realHostname(),
      });
      if (request.captureWarnings === true) {
        await configure({
          reset: true,
          sinks: {
            kept: (record) => {
              warnings.push(
                record.message.map((part) => String(part)).join(""),
              );
            },
          },
          loggers: [
            {
              category: ["datastore"],
              sinks: ["kept"],
              lowestLevel: "warning",
            },
            {
              category: ["swamp", "datastore", "read-model"],
              sinks: ["kept"],
              lowestLevel: "warning",
            },
            { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
          ],
        });
      }
      setV3ReplicationForTesting({
        processes: {
          ...hostLitestreamProcesses,
          launch: (launch) => {
            const pid = hostLitestreamProcesses.launch(launch);
            launched.add(pid);
            return pid;
          },
        },
        privateRoot: request.privateRoot,
        timings: TEST_TIMINGS,
        ...(request.gated === true
          ? { resolveBinary: () => gatedBinary(request) }
          : {}),
        ...(request.binaryMissing === true
          ? {
            resolveBinary: () =>
              Promise.reject(new Error("no Litestream binary on this host")),
          }
          : {}),
      });
      return undefined;
    }
    case "lease":
      return await inEnv(async () => {
        leaseRelease = await acquireV3WriterLock(init!.datastorePath, {
          ttlMs: request.ttlMs,
          ...(request.retake === true ? { retakeLost: true } : {}),
        });
      });
    case "write":
      return await inEnv(async () => {
        await holdV3Writer(config(), init!.repoDir);
        await commitIn(
          { repoDir: init!.repoDir, config: config() },
          request.commits,
        );
        if (request.close) await closeV3Datastores();
      });
    case "confirm":
      return await inEnv(() => confirmV3Replicated(init!.datastorePath));
    case "plantOutboxEntry":
      return await inEnv(() => {
        const path = v3OutboxPath(
          v3CommitsDbPath(init!.datastorePath, init!.repoDir),
        );
        const db = new DatabaseSync(path);
        try {
          db.prepare(
            "INSERT INTO outbox_entries (namespace, partition, txn_id, unit_id, base_seq, created_at, body) " +
              "VALUES ('', 'planted', ?, 'unit', 0, 0, '{}')",
          ).run(crypto.randomUUID());
        } finally {
          db.close();
        }
        return Promise.resolve(path);
      });
    case "claim":
    case "release":
      return await inEnv(async () => {
        try {
          await holdV3Writer(config(), init!.repoDir, {
            ownerCheck: { as: "claimer" },
          });
          const log = v3ClaimCommitLog(init!.repoDir, config());
          if (request.kind === "release") {
            await log.release();
            return undefined;
          }
          await log.catchUp(new AbortController().signal);
          await log.claim(DatastoreOwner.create({
            address: request.address,
            claimedAt: new Date().toISOString(),
            claimedAtCursor: log.highWaterCursor(),
          }));
          return undefined;
        } finally {
          await closeV3Datastores();
        }
      });
    case "close":
      return await inEnv(async () => {
        try {
          await closeV3Datastores();
        } finally {
          await leaseRelease?.();
          leaseRelease = undefined;
        }
      });
    case "read":
      return await inEnv(async () => {
        const refresh = await ensureV3CopyCurrent(
          init!.repoDir,
          config(),
          "read",
        );
        await v3RepositoryFactoryConfig(init!.repoDir, config(), {
          readOnly: true,
        });
        const commits = count(
          v3CommitsDbPath(init!.datastorePath, init!.repoDir),
        );
        await closeV3Datastores();
        return { commits, restored: refresh.restored ?? null };
      });
    case "pause":
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.ms);
      return undefined;
    case "upkeep":
      return await inEnv(() => {
        upkeep = startV3ReplicationUpkeep(init!.repoDir, config(), {
          probeIntervalMs: request.probeMs,
        });
        return Promise.resolve();
      });
    case "stopUpkeep":
      await upkeep?.stop();
      upkeep = undefined;
      return undefined;
    case "pids":
      return [...launched];
    case "tryCommit":
      try {
        await commitIn({ repoDir: init!.repoDir, config: config() }, 1);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    case "gc":
      try {
        await v3DatastoreFor(init!.repoDir, config()).collectChunks(
          AbortSignal.timeout(30_000),
        );
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    case "restoreLock":
      return (await replicationPathsFor(
        v3CommitsDbPath(init!.datastorePath, init!.repoDir),
        init!.privateRoot,
      )).restoreLock;
    case "fence":
      return v3WriterFence(init!.datastorePath) ?? null;
    case "count":
      return count(v3CommitsDbPath(init!.datastorePath, init!.repoDir));
    case "warnings":
      return warnings.splice(0);
    case "catchUp":
      await v3DatastoreFor(init!.repoDir, config()).catchUp();
      return undefined;
    case "readModel":
      return await inEnv(async () => {
        await ensureV3CopyCurrent(init!.repoDir, config(), "read");
        const handle = v3DatastoreFor(init!.repoDir, config());
        const state = {
          cursor: handle.readModel.cursor(),
          populated: handle.catalogStore.isPopulated(),
        };
        await closeV3Datastores();
        return state;
      });
    case "namespaces":
      return await inEnv(async () => {
        const deps = await createNamespaceListDeps(config(), init!.repoDir);
        const listed = await deps.listNamespaces();
        await closeV3Datastores();
        return listed.map((entry) => entry.namespace);
      });
    case "files": {
      const dir = join(init!.repoDir, ".swamp", "auto-definitions");
      const names: string[] = [];
      try {
        for await (const entry of Deno.readDir(dir)) names.push(entry.name);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      return names.sort();
    }
  }
}

self.onmessage = async (event: MessageEvent<MachineRequest>) => {
  try {
    self.postMessage(
      { ok: true, value: await handle(event.data) } satisfies MachineResponse,
    );
  } catch (error) {
    self.postMessage(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && "code" in error &&
            typeof error.code === "string"
          ? { code: error.code }
          : {}),
      } satisfies MachineResponse,
    );
  }
};
