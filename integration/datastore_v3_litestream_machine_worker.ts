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
 * One "machine" for the v3 restore tests (swamp-club#3482): a worker with
 * its own module state, so its writer lease, sidecar and handles are its
 * own, and its own host name as its writer lease sees it, so another
 * machine's lease expires by its TTL as a remote holder's does. Its checkout is its own; the datastore and
 * the replica are shared. `pause` blocks the worker's thread as a stalled
 * process would: its lease renewals stop, its Litestream sidecar does not.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { LOCK_TIMEOUT_ENV_VAR } from "../src/domain/datastore/datastore_config.ts";
import { V3_REPLICA_ENV } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import {
  closeV3Datastores,
  ensureV3CopyCurrent,
  holdV3Writer,
  startV3ReplicationUpkeep,
  v3DatastoreFor,
  type V3ReplicationUpkeep,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { acquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { v3CommitsDbPath } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { replicationPathsFor } from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import type { FilesystemDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { commitIn, TEST_TIMINGS } from "./datastore_v3_litestream_helpers.ts";

/** What the test asks a machine to do. */
export type MachineRequest =
  | {
    readonly kind: "init";
    readonly hostname: string;
    readonly replica: string;
    readonly privateRoot: string;
    readonly datastorePath: string;
    readonly repoDir: string;
    readonly lockTimeoutMs: number;
  }
  /** Takes the lease with a short TTL, so a pause lets it expire. */
  | {
    readonly kind: "lease";
    readonly ttlMs: number;
    readonly retake?: boolean;
  }
  /** One write command's hold and commits; `close` tears it down. */
  | {
    readonly kind: "write";
    readonly commits: number;
    readonly close: boolean;
  }
  | { readonly kind: "close" }
  /** A read-only command: makes the copy current, counts its commits. */
  | { readonly kind: "read" }
  | { readonly kind: "pause"; readonly ms: number }
  /** Serve's upkeep of its sidecar, with a short probe. */
  | { readonly kind: "upkeep"; readonly probeMs: number }
  | { readonly kind: "stopUpkeep" }
  /** The supervisors this machine launched, for the test's cleanup. */
  | { readonly kind: "pids" }
  /** The record files the checkout's read model materialised. */
  | { readonly kind: "files" }
  /** Catches the open handle's read model up, as a context opening does. */
  | { readonly kind: "catchUp" }
  /** One commit on the held writer; resolves with the refusal, if any. */
  | { readonly kind: "tryCommit" }
  /** Chunk collection on the open handle; resolves with the refusal, if any. */
  | { readonly kind: "gc" }
  /** The checkout copy's restore lock. */
  | { readonly kind: "restoreLock" };

/** A machine's answer. */
export type MachineResponse =
  | { readonly ok: true; readonly value?: unknown }
  | { readonly ok: false; readonly error: string; readonly code?: string };

declare const self: Worker;

let init: Extract<MachineRequest, { kind: "init" }> | undefined;
let upkeep: V3ReplicationUpkeep | undefined;
/** The short lease a `lease` request took, released when the machine closes. */
let leaseRelease: (() => Promise<void>) | undefined;
const launched = new Set<number>();

function config(): FilesystemDatastoreConfig {
  return { type: "filesystem", path: init!.datastorePath };
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
      // Only the writer lease sees this machine's name: another machine's
      // lease then expires by its TTL, as a remote holder's does. The
      // sidecar's supervisor is a real process on this host, which its
      // checks must still recognise.
      const hostname = request.hostname;
      const realHostname = Deno.hostname.bind(Deno);
      Object.defineProperty(Deno, "hostname", {
        configurable: true,
        value: () =>
          /v3_writer_lock\.ts|writer_lease\.ts/.test(new Error().stack ?? "")
            ? hostname
            : realHostname(),
      });
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
        // A read-only command's context: the copy made current, then the
        // read model caught up.
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
    case "catchUp":
      await v3DatastoreFor(init!.repoDir, config()).catchUp();
      return undefined;
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
