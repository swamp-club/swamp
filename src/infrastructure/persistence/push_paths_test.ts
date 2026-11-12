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

import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { initializeLogging } from "../logging/logger.ts";
import {
  getRegisteredLockKeys,
  registerDatastoreSync,
} from "./datastore_sync_coordinator.ts";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";
import {
  DatastorePushFailedError,
  type DatastoreSyncOptions,
  SyncTimeoutError,
} from "../../domain/datastore/datastore_sync_service.ts";
import { configure, type LogRecord } from "@logtape/logtape";
import {
  pushBoundOf,
  pushGlobalLockAtEnd,
  pushModelLockScope,
  pushNamespace,
} from "./push_paths.ts";
import {
  type CustomDatastoreConfig,
  SYNC_TIMEOUT_ENV_VAR,
} from "../../domain/datastore/datastore_config.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

await initializeLogging({});

function recordingService(
  result: () => Promise<number> = () => Promise.resolve(2),
) {
  const pushes: (DatastoreSyncOptions | undefined)[] = [];
  return {
    pushes,
    service: {
      pullChanged: () => Promise.resolve(0),
      markDirty: () => Promise.resolve(),
      pushChanged: (options?: DatastoreSyncOptions) => {
        pushes.push(options);
        return result();
      },
    },
  };
}

function countingLock(): DistributedLock & { releases: () => number } {
  let releases = 0;
  return {
    acquire: () => Promise.resolve(),
    release: () => {
      releases++;
      return Promise.resolve();
    },
    withLock: <T>(fn: () => Promise<T>) => fn(),
    inspect: () => Promise.resolve(null),
    forceRelease: () => Promise.resolve(false),
    releases: () => releases,
  };
}

Deno.test("pushNamespace: pushes the namespace exactly as given, with the deadline's signal", async () => {
  const { pushes, service } = recordingService();
  await pushNamespace(service, "ns");
  await pushNamespace(service, undefined);
  assertEquals(pushes.map((p) => p?.namespace), ["ns", undefined]);
  for (const push of pushes) assertInstanceOf(push?.signal, AbortSignal);
});

Deno.test("pushNamespace: a push that never settles fails at its bound and is told to stop", async () => {
  const { pushes, service } = recordingService(() => new Promise(() => {}));
  const error = await assertRejects(
    () =>
      pushNamespace(service, "ns", { label: "@test/wedged", timeoutMs: 50 }),
    SyncTimeoutError,
  );
  assertEquals(error.label, "@test/wedged");
  assertEquals(error.direction, "push");
  assertEquals(pushes[0]?.signal?.aborted, true);
});

Deno.test("pushNamespace: without a bound it takes the environment's sync timeout", async () => {
  const { service } = recordingService(() => new Promise(() => {}));
  const error = await withMockedEnv(
    { [SYNC_TIMEOUT_ENV_VAR]: "50" },
    () => assertRejects(() => pushNamespace(service, "ns"), SyncTimeoutError),
  );
  assertEquals(error.timeoutMs, 50);
});

Deno.test("pushBoundOf: names the datastore type and its configured sync timeout", () => {
  assertEquals(
    pushBoundOf({
      type: "@test/store",
      config: {},
      datastorePath: "/tmp/x",
      syncTimeoutMs: 1234,
    } as CustomDatastoreConfig),
    { label: "@test/store", timeoutMs: 1234 },
  );
});

Deno.test("pushModelLockScope: scoped sync pushes the locked models, with the namespace when there is one", async () => {
  const { pushes, service } = recordingService();
  const models = [{ modelType: "t", modelId: "1" }];
  assertEquals(await pushModelLockScope(service, true, models, "ns"), 2);
  await pushModelLockScope(service, true, models, undefined);
  assertEquals(pushes, [
    { context: { models }, namespace: "ns" },
    { context: { models } },
  ]);
});

Deno.test("pushModelLockScope: passes the deadline's signal on every shape of push", async () => {
  const { pushes, service } = recordingService();
  const models = [{ modelType: "t", modelId: "1" }];
  const signal = new AbortController().signal;
  await pushModelLockScope(service, true, models, "ns", signal);
  await pushModelLockScope(service, false, models, "ns", signal);
  await pushModelLockScope(service, false, models, undefined, signal);
  assertEquals(pushes, [
    { context: { models }, namespace: "ns", signal },
    { namespace: "ns", signal },
    { signal },
  ]);
});

Deno.test("pushModelLockScope: without scoped sync it pushes the namespace, or everything", async () => {
  const { pushes, service } = recordingService();
  const models = [{ modelType: "t", modelId: "1" }];
  await pushModelLockScope(service, false, models, "ns");
  await pushModelLockScope(service, false, models, undefined);
  assertEquals(pushes, [{ namespace: "ns" }, undefined]);
});

Deno.test("pushGlobalLockAtEnd: pushes once and releases the global lock, and a second call does nothing", async () => {
  const { pushes, service } = recordingService();
  const lock = countingLock();
  await registerDatastoreSync({ service, lock });
  await pushGlobalLockAtEnd({ completed: true });
  await pushGlobalLockAtEnd({ completed: true });
  assertEquals(pushes.length, 1);
  assertEquals(lock.releases(), 1);
  assertEquals(getRegisteredLockKeys(), []);
});

Deno.test("pushGlobalLockAtEnd: does nothing when no global sync is registered", async () => {
  assertEquals(getRegisteredLockKeys(), []);
  await pushGlobalLockAtEnd({ completed: true });
});

Deno.test("pushGlobalLockAtEnd: a push timeout after the command completed is thrown, after the lock is released", async () => {
  const timeout = new SyncTimeoutError("test", "push", 1);
  const { service } = recordingService(() => Promise.reject(timeout));
  const lock = countingLock();
  await registerDatastoreSync({ service, lock });
  const thrown = await assertRejects(() =>
    pushGlobalLockAtEnd({ completed: true })
  );
  assertStrictEquals(thrown, timeout);
  assertEquals(lock.releases(), 1);
  assertEquals(getRegisteredLockKeys(), []);
});

Deno.test("pushGlobalLockAtEnd: a push timeout after the command failed is dropped, and the lock is released", async () => {
  const timeout = new SyncTimeoutError("test", "push", 1);
  const { service } = recordingService(() => Promise.reject(timeout));
  const lock = countingLock();
  await registerDatastoreSync({ service, lock });
  await pushGlobalLockAtEnd({ completed: false });
  assertEquals(lock.releases(), 1);
  assertEquals(getRegisteredLockKeys(), []);
});

Deno.test("pushGlobalLockAtEnd: a failed push after the command failed is dropped with a warning, and the lock is released", async () => {
  const { service } = recordingService(() =>
    Promise.reject(new Error("fetch failed"))
  );
  const lock = countingLock();
  await registerDatastoreSync({ service, lock, label: "@test/store" });
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: ["datastore"], lowestLevel: "warning", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  try {
    await pushGlobalLockAtEnd({ completed: false });
  } finally {
    await initializeLogging({ _reset: true });
  }
  assertEquals(lock.releases(), 1);
  assertEquals(getRegisteredLockKeys(), []);
  assertEquals(captured.length, 1);
  assertEquals(captured[0].level, "warning");
  assertEquals(
    captured[0].properties.error,
    "@test/store push failed: fetch failed",
  );
});

Deno.test("pushGlobalLockAtEnd: a failed push after the command completed is thrown as DatastorePushFailedError", async () => {
  const { service } = recordingService(() =>
    Promise.reject(new Error("fetch failed"))
  );
  const lock = countingLock();
  await registerDatastoreSync({ service, lock, label: "@test/store" });
  const error = await assertRejects(
    () => pushGlobalLockAtEnd({ completed: true }),
    DatastorePushFailedError,
  );
  assertEquals(error.code, "datastore_push_failed");
  assertEquals(lock.releases(), 1);
});
