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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { initializeLogging } from "../logging/logger.ts";
import {
  getRegisteredLockKeys,
  registerDatastoreSync,
} from "./datastore_sync_coordinator.ts";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";
import {
  type DatastoreSyncOptions,
  SyncTimeoutError,
} from "../../domain/datastore/datastore_sync_service.ts";
import {
  pushGlobalLockAtEnd,
  pushModelLockScope,
  pushNamespace,
} from "./push_paths.ts";

await initializeLogging({});

/** A sync service that records each push's options. */
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

/** A lock that counts its releases. */
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

Deno.test("pushNamespace: pushes the namespace exactly as given", async () => {
  const { pushes, service } = recordingService();
  await pushNamespace(service, "ns");
  await pushNamespace(service, undefined);
  assertEquals(pushes, [{ namespace: "ns" }, { namespace: undefined }]);
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
