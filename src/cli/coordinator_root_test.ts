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
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  getRegisteredLockKeys,
  registerDatastoreSync,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { currentUnitOfWork } from "../infrastructure/persistence/unit_of_work_scope.ts";
import { SyncTimeoutError } from "../domain/datastore/datastore_sync_service.ts";
import { runInCoordinatorRoot } from "./coordinator_root.ts";

await initializeLogging({});

/** A sync service whose push runs `push`, counting its calls. */
function countingService(
  push: () => Promise<number> = () => Promise.resolve(0),
) {
  let pushes = 0;
  return {
    pushes: () => pushes,
    service: {
      pullChanged: () => Promise.resolve(0),
      markDirty: () => Promise.resolve(),
      pushChanged: () => {
        pushes++;
        return push();
      },
    },
  };
}

const hook = () => Promise.resolve();

Deno.test("runInCoordinatorRoot: runs fn in a root and pushes the global lock once when it ends", async () => {
  const { pushes, service } = countingService();
  await registerDatastoreSync({ service });
  let inRoot = false;
  const value = await runInCoordinatorRoot({ markDirty: hook }, () => {
    inRoot = currentUnitOfWork() !== undefined;
    assertEquals(pushes(), 0);
    return Promise.resolve(7);
  });
  assertEquals(value, 7);
  assertEquals(inRoot, true);
  assertEquals(pushes(), 1);
  assertEquals(getRegisteredLockKeys(), []);
});

Deno.test("runInCoordinatorRoot: still pushes when fn throws, and fn's error wins over a push timeout", async () => {
  const { pushes, service } = countingService(() =>
    Promise.reject(new SyncTimeoutError("test", "push", 1))
  );
  await registerDatastoreSync({ service });
  const error = new Error("command failed");
  const thrown = await assertRejects(() =>
    runInCoordinatorRoot({ markDirty: hook }, () => Promise.reject(error))
  );
  assertStrictEquals(thrown, error);
  assertEquals(pushes(), 1);
  assertEquals(getRegisteredLockKeys(), []);
});

Deno.test("runInCoordinatorRoot: a push timeout after fn resolved is thrown", async () => {
  const timeout = new SyncTimeoutError("test", "push", 1);
  const { service } = countingService(() => Promise.reject(timeout));
  await registerDatastoreSync({ service });
  const thrown = await assertRejects(() =>
    runInCoordinatorRoot({ markDirty: hook }, () => Promise.resolve())
  );
  assertStrictEquals(thrown, timeout);
});
