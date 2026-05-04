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
import { SEPARATOR } from "@std/path";
import { assertCompletes, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDatastoreLockStatusDeps,
  datastoreLockRelease,
  type DatastoreLockReleaseDeps,
  type DatastoreLockReleaseEvent,
  datastoreLockStatus,
  type DatastoreLockStatusDeps,
  type DatastoreLockStatusEvent,
  type LockInfo,
  parseModelLockKey,
  parseModelSpec,
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
      datastoreType: "custom",
      isFilesystemDatastore: false,
    }),
    {
      kind: "completed",
      data: {
        held: false,
        info: undefined,
        datastoreType: "custom",
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

// ── parseModelLockKey ──────────────────────────────────────────────────

Deno.test("parseModelLockKey: simple model type", () => {
  const result = parseModelLockKey(
    ["data", "aws-ec2", "server-1", ".lock"].join(SEPARATOR),
  );
  assertEquals(result, { modelType: "aws-ec2", modelId: "server-1" });
});

Deno.test("parseModelLockKey: scoped extension type", () => {
  const result = parseModelLockKey(
    ["data", "@hivemq", "harvester-host-kernel", "abc-123", ".lock"].join(
      SEPARATOR,
    ),
  );
  assertEquals(result, {
    modelType: "@hivemq/harvester-host-kernel",
    modelId: "abc-123",
  });
});

Deno.test("parseModelLockKey: deeply scoped type", () => {
  const result = parseModelLockKey(
    ["data", "@org", "team", "feature", "instance-1", ".lock"].join(SEPARATOR),
  );
  assertEquals(result, {
    modelType: "@org/team/feature",
    modelId: "instance-1",
  });
});

Deno.test("parseModelLockKey: missing data prefix returns null", () => {
  const result = parseModelLockKey(
    ["other", "aws-ec2", "server-1", ".lock"].join(SEPARATOR),
  );
  assertEquals(result, null);
});

Deno.test("parseModelLockKey: missing .lock suffix returns null", () => {
  const result = parseModelLockKey(
    ["data", "aws-ec2", "server-1", "info.json"].join(SEPARATOR),
  );
  assertEquals(result, null);
});

Deno.test("parseModelLockKey: too few parts returns null", () => {
  const result = parseModelLockKey(
    ["data", "aws-ec2", ".lock"].join(SEPARATOR),
  );
  assertEquals(result, null);
});

Deno.test("parseModelLockKey: handles forward-slash input on any platform", () => {
  // Simulates the case where rel happens to contain `/` on Windows (e.g.
  // someone constructed the path manually with forward slashes); on POSIX
  // this is the normal case. The function should accept it on POSIX and
  // would return null on Windows where SEPARATOR is `\` — the test
  // harness is platform-aware.
  const rel = "data/aws-ec2/server-1/.lock";
  const result = parseModelLockKey(rel);
  if (SEPARATOR === "/") {
    assertEquals(result, { modelType: "aws-ec2", modelId: "server-1" });
  } else {
    assertEquals(result, null);
  }
});

// ── parseModelSpec ─────────────────────────────────────────────────────

Deno.test("parseModelSpec: simple type/id", () => {
  assertEquals(parseModelSpec("aws-ec2/server-1"), {
    modelType: "aws-ec2",
    modelId: "server-1",
  });
});

Deno.test("parseModelSpec: scoped extension type", () => {
  assertEquals(parseModelSpec("@hivemq/harvester-host-kernel/abc-123"), {
    modelType: "@hivemq/harvester-host-kernel",
    modelId: "abc-123",
  });
});

Deno.test("parseModelSpec: deeply scoped type", () => {
  assertEquals(parseModelSpec("@org/team/feature/instance-1"), {
    modelType: "@org/team/feature",
    modelId: "instance-1",
  });
});

Deno.test("parseModelSpec: no slash returns null", () => {
  assertEquals(parseModelSpec("just-a-name"), null);
});

Deno.test("parseModelSpec: leading slash (empty modelType) returns null", () => {
  assertEquals(parseModelSpec("/server-1"), null);
});

Deno.test("parseModelSpec: trailing slash (empty modelId) returns null", () => {
  assertEquals(parseModelSpec("aws-ec2/"), null);
});

Deno.test("parseModelSpec: empty string returns null", () => {
  assertEquals(parseModelSpec(""), null);
});

// ── Functional: scanModelLocks against real filesystem ────────────────

Deno.test("scanModelLocks: finds both simple and scoped extension type locks", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-scan-" });
  try {
    // Plant a simple-type lock and a scoped-type lock with active TTLs.
    const now = new Date().toISOString();
    const lock = JSON.stringify({
      holder: "h@h",
      hostname: "h",
      pid: 1,
      acquiredAt: now,
      ttlMs: 600000,
      nonce: "n",
    });
    await Deno.mkdir(`${dir}/data/aws-ec2/server-1`, { recursive: true });
    await Deno.writeTextFile(`${dir}/data/aws-ec2/server-1/.lock`, lock);
    await Deno.mkdir(`${dir}/data/@hivemq/harvester-host-kernel/abc`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${dir}/data/@hivemq/harvester-host-kernel/abc/.lock`,
      lock,
    );

    const deps = createDatastoreLockStatusDeps(
      // globalLock is unused by scanModelLocks; pass a stub
      {
        // deno-lint-ignore require-await
        async inspect() {
          return null;
        },
      } as unknown as Parameters<typeof createDatastoreLockStatusDeps>[0],
      { type: "filesystem", path: dir },
    );

    const locks = await deps.scanModelLocks();
    const scopes = locks.map((l) => `${l.modelType}/${l.modelId}`).sort();
    assertEquals(scopes, [
      "@hivemq/harvester-host-kernel/abc",
      "aws-ec2/server-1",
    ]);
    // Canonical lockKey form uses `/` regardless of platform.
    const keys = locks.map((l) => l.lockKey).sort();
    assertEquals(keys, [
      "data/@hivemq/harvester-host-kernel/abc/.lock",
      "data/aws-ec2/server-1/.lock",
    ]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
