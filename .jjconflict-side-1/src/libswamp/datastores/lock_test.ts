// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals } from "@std/assert";
import { assertCompletes, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreLockRelease,
  type DatastoreLockReleaseDeps,
  type DatastoreLockReleaseEvent,
  datastoreLockStatus,
  type DatastoreLockStatusDeps,
  type DatastoreLockStatusEvent,
  type LockInfo,
} from "./lock.ts";

const sampleLockInfo: LockInfo = {
  holder: "testuser@testhost",
  hostname: "testhost",
  pid: 12345,
  acquiredAt: new Date().toISOString(),
  ttlMs: 30000,
  nonce: "abc-123",
};

// ── Lock status tests ──────────────────────────────────────────────────

function makeStatusDeps(
  overrides: Partial<DatastoreLockStatusDeps> = {},
): DatastoreLockStatusDeps {
  return {
    inspectGlobalLock: () => Promise.resolve(null),
    scanModelLocks: () => Promise.resolve([]),
    ...overrides,
  };
}

Deno.test("datastoreLockStatus: no lock held", async () => {
  const deps = makeStatusDeps();

  await assertCompletes<DatastoreLockStatusEvent>(
    datastoreLockStatus(createLibSwampContext(), deps, {
      datastoreType: "filesystem",
      isFilesystemDatastore: true,
    }),
    {
      kind: "completed",
      data: {
        held: false,
        info: undefined,
        datastoreType: "filesystem",
      },
    },
  );
});

Deno.test("datastoreLockStatus: global lock held", async () => {
  const deps = makeStatusDeps({
    inspectGlobalLock: () => Promise.resolve(sampleLockInfo),
  });

  await assertCompletes<DatastoreLockStatusEvent>(
    datastoreLockStatus(createLibSwampContext(), deps, {
      datastoreType: "filesystem",
      isFilesystemDatastore: true,
    }),
    {
      kind: "completed",
      data: {
        held: true,
        info: sampleLockInfo,
        datastoreType: "filesystem",
      },
    },
  );
});

Deno.test("datastoreLockStatus: with model locks on filesystem", async () => {
  const deps = makeStatusDeps({
    scanModelLocks: () =>
      Promise.resolve([
        {
          lockKey: "data/aws-ec2/my-server/.lock",
          modelType: "aws-ec2",
          modelId: "my-server",
          info: sampleLockInfo,
        },
      ]),
  });

  const events = await collect<DatastoreLockStatusEvent>(
    datastoreLockStatus(createLibSwampContext(), deps, {
      datastoreType: "filesystem",
      isFilesystemDatastore: true,
    }),
  );

  assertEquals(events.length, 2);
  // model_lock events come first
  const modelLock = events[0] as Extract<
    DatastoreLockStatusEvent,
    { kind: "model_lock" }
  >;
  assertEquals(modelLock.kind, "model_lock");
  assertEquals(modelLock.data.held, true);
  assertEquals(modelLock.data.lockScope, "aws-ec2/my-server");
  // completed comes last
  assertEquals(events[1].kind, "completed");
});

Deno.test("datastoreLockStatus: skips model lock scan for non-filesystem", async () => {
  const deps = makeStatusDeps({
    scanModelLocks: () =>
      Promise.resolve([
        {
          lockKey: "data/aws-ec2/my-server/.lock",
          modelType: "aws-ec2",
          modelId: "my-server",
          info: sampleLockInfo,
        },
      ]),
  });

  // Should only have the global lock status, no model locks
  await assertCompletes<DatastoreLockStatusEvent>(
    datastoreLockStatus(createLibSwampContext(), deps, {
      datastoreType: "s3",
      isFilesystemDatastore: false,
    }),
    {
      kind: "completed",
      data: {
        held: false,
        info: undefined,
        datastoreType: "s3",
      },
    },
  );
});

// ── Lock release tests ─────────────────────────────────────────────────

function makeReleaseDeps(
  overrides: Partial<DatastoreLockReleaseDeps> = {},
): DatastoreLockReleaseDeps {
  return {
    inspectLock: () => Promise.resolve(sampleLockInfo),
    forceRelease: () => Promise.resolve(true),
    ...overrides,
  };
}

Deno.test("datastoreLockRelease: no lock held", async () => {
  const deps = makeReleaseDeps({
    inspectLock: () => Promise.resolve(null),
  });

  await assertCompletes<DatastoreLockReleaseEvent>(
    datastoreLockRelease(createLibSwampContext(), deps, {}),
    {
      kind: "completed",
      data: {
        released: false,
        reason: "no lock held",
      },
    },
  );
});

Deno.test("datastoreLockRelease: successful release", async () => {
  let releasedNonce = "";
  const deps = makeReleaseDeps({
    forceRelease: (nonce) => {
      releasedNonce = nonce;
      return Promise.resolve(true);
    },
  });

  await assertCompletes<DatastoreLockReleaseEvent>(
    datastoreLockRelease(createLibSwampContext(), deps, {}),
    {
      kind: "completed",
      data: {
        released: true,
        previousHolder: sampleLockInfo,
      },
    },
  );
  assertEquals(releasedNonce, "abc-123");
});

Deno.test("datastoreLockRelease: nonce mismatch (holder changed)", async () => {
  const deps = makeReleaseDeps({
    forceRelease: () => Promise.resolve(false),
  });

  await assertCompletes<DatastoreLockReleaseEvent>(
    datastoreLockRelease(createLibSwampContext(), deps, {}),
    {
      kind: "completed",
      data: {
        released: false,
        reason:
          "lock holder changed — aborting to avoid breaking an active lock",
      },
    },
  );
});
