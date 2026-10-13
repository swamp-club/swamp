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

import { assertEquals, assertRejects } from "@std/assert";
import { createDatastoreTestContext } from "@swamp-club/swamp-testing";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
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
  modelLockKey,
  parseModelLockKey,
  parseModelSpec,
  stripNamespacePrefix,
  workflowRunLockKey,
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

Deno.test("datastoreLockStatus: reports model locks on a custom datastore", async () => {
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
      datastoreType: "@swamp/s3-datastore",
      isFilesystemDatastore: false,
    }),
  );

  assertEquals(events, [
    {
      kind: "model_lock",
      data: {
        held: true,
        info: sampleLockInfo,
        datastoreType: "@swamp/s3-datastore",
        lockScope: "aws-ec2/my-server",
      },
    },
    {
      kind: "completed",
      data: {
        held: false,
        info: undefined,
        datastoreType: "@swamp/s3-datastore",
      },
    },
  ]);
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

Deno.test("datastoreLockRelease: lock being written is not force-released", async () => {
  let forceReleaseCalls = 0;
  const deps = makeReleaseDeps({
    inspectLock: () =>
      Promise.resolve({
        holder: "unknown (lock file is being written)",
        hostname: "unknown",
        pid: 0,
        acquiredAt: new Date().toISOString(),
        ttlMs: 30000,
        holderUnknown: true,
      }),
    forceRelease: () => {
      forceReleaseCalls++;
      return Promise.resolve(false);
    },
  });

  await assertCompletes<DatastoreLockReleaseEvent>(
    datastoreLockRelease(createLibSwampContext(), deps, {}),
    {
      kind: "completed",
      data: {
        released: false,
        reason: "lock is being written by its holder — retry shortly",
      },
    },
  );
  assertEquals(forceReleaseCalls, 0);
});

Deno.test("datastoreLockRelease: old-format lock with no nonce still reaches forceRelease", async () => {
  const { nonce: _nonce, ...oldFormat } = sampleLockInfo;
  let forceReleaseCalls = 0;
  const deps = makeReleaseDeps({
    inspectLock: () => Promise.resolve(oldFormat),
    forceRelease: () => {
      forceReleaseCalls++;
      return Promise.resolve(true);
    },
  });

  await assertCompletes<DatastoreLockReleaseEvent>(
    datastoreLockRelease(createLibSwampContext(), deps, {}),
    {
      kind: "completed",
      data: { released: true, previousHolder: oldFormat },
    },
  );
  assertEquals(forceReleaseCalls, 1);
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

// ── modelLockKey ──────────────────────────────────────────────────────

Deno.test("modelLockKey: without namespace", () => {
  assertEquals(
    modelLockKey(undefined, "aws-ec2", "server-1"),
    "data/aws-ec2/server-1/.lock",
  );
});

Deno.test("modelLockKey: with empty namespace", () => {
  assertEquals(
    modelLockKey("", "aws-ec2", "server-1"),
    "data/aws-ec2/server-1/.lock",
  );
});

Deno.test("modelLockKey: with namespace", () => {
  assertEquals(
    modelLockKey("infra", "aws-ec2", "server-1"),
    "infra/data/aws-ec2/server-1/.lock",
  );
});

Deno.test("modelLockKey: with namespace and scoped extension type", () => {
  assertEquals(
    modelLockKey("asdlc", "@hivemq/harvester-host-kernel", "abc-123"),
    "asdlc/data/@hivemq/harvester-host-kernel/abc-123/.lock",
  );
});

// ── stripNamespacePrefix ──────────────────────────────────────────────

Deno.test("stripNamespacePrefix: no namespace returns input unchanged", () => {
  const rel = ["data", "aws-ec2", "server-1", ".lock"].join(SEPARATOR);
  assertEquals(stripNamespacePrefix(undefined, rel), rel);
});

Deno.test("stripNamespacePrefix: empty namespace returns input unchanged", () => {
  const rel = ["data", "aws-ec2", "server-1", ".lock"].join(SEPARATOR);
  assertEquals(stripNamespacePrefix("", rel), rel);
});

Deno.test("stripNamespacePrefix: strips matching namespace prefix", () => {
  const rel = ["infra", "data", "aws-ec2", "server-1", ".lock"].join(SEPARATOR);
  const stripped = ["data", "aws-ec2", "server-1", ".lock"].join(SEPARATOR);
  assertEquals(stripNamespacePrefix("infra", rel), stripped);
});

Deno.test("stripNamespacePrefix: non-matching prefix returns input unchanged", () => {
  const rel = ["other", "data", "aws-ec2", "server-1", ".lock"].join(SEPARATOR);
  assertEquals(stripNamespacePrefix("infra", rel), rel);
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

Deno.test("scanModelLocks: finds locks under namespace-scoped directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-ns-scan-" });
  try {
    const now = new Date().toISOString();
    const lock = JSON.stringify({
      holder: "h@h",
      hostname: "h",
      pid: 1,
      acquiredAt: now,
      ttlMs: 600000,
      nonce: "n",
    });
    await Deno.mkdir(`${dir}/myns/data/aws-ec2/server-1`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/myns/data/aws-ec2/server-1/.lock`,
      lock,
    );

    const deps = createDatastoreLockStatusDeps(
      {
        // deno-lint-ignore require-await
        async inspect() {
          return null;
        },
      } as unknown as Parameters<typeof createDatastoreLockStatusDeps>[0],
      { type: "filesystem", path: dir, namespace: "myns" },
    );

    const locks = await deps.scanModelLocks();
    assertEquals(locks.length, 1);
    assertEquals(locks[0].modelType, "aws-ec2");
    assertEquals(locks[0].modelId, "server-1");
    assertEquals(locks[0].lockKey, "myns/data/aws-ec2/server-1/.lock");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// ── workflowRunLockKey ────────────────────────────────────────────────

Deno.test("workflowRunLockKey: without namespace", () => {
  assertEquals(
    workflowRunLockKey(undefined, "run-1"),
    "workflow-run-claims/run-1/.lock",
  );
});

Deno.test("workflowRunLockKey: with namespace", () => {
  assertEquals(
    workflowRunLockKey("infra", "run-1"),
    "infra/workflow-run-claims/run-1/.lock",
  );
});

Deno.test("workflowRunLockKey: is not read as a per-model lock", () => {
  const rel = workflowRunLockKey(undefined, "run-1").split("/").join(SEPARATOR);
  assertEquals(parseModelLockKey(rel), null);
});

// ── Custom datastores: model locks through the provider's lock ─────────

const unusedGlobalLock = {
  inspect: () => Promise.resolve(null),
} as unknown as DistributedLock;

function customConfig(namespace?: string): CustomDatastoreConfig {
  return {
    type: "@swamp/s3-datastore",
    config: {},
    datastorePath: "/tmp/unused",
    ...(namespace ? { namespace } : {}),
  };
}

Deno.test("createDatastoreLockStatusDeps: reports a held model lock on a custom datastore", async () => {
  const { provider } = createDatastoreTestContext();
  const createLock = (lockKey: string) => provider.createLock("", { lockKey });

  const holder = createLock(modelLockKey(undefined, "aws-ec2", "my-server"));
  await holder.acquire();

  const deps = createDatastoreLockStatusDeps(unusedGlobalLock, customConfig(), {
    listModels: () =>
      Promise.resolve([
        { modelType: "aws-ec2", modelId: "my-server" },
        { modelType: "aws-ec2", modelId: "idle-server" },
      ]),
    createLock,
  });

  const locks = await deps.scanModelLocks();
  assertEquals(locks.length, 1);
  assertEquals(locks[0].lockKey, "data/aws-ec2/my-server/.lock");
  assertEquals(locks[0].modelType, "aws-ec2");
  assertEquals(locks[0].modelId, "my-server");
  assertEquals(locks[0].info.holder, "test-user@test-host");
  assertEquals(locks[0].info.pid, 1234);

  await holder.release();
  assertEquals(await deps.scanModelLocks(), []);
});

Deno.test("createDatastoreLockStatusDeps: builds namespaced keys for scoped types", async () => {
  const { provider, getLockOperations } = createDatastoreTestContext();
  const createLock = (lockKey: string) => provider.createLock("", { lockKey });

  const holder = createLock("infra/data/@scope/type/abc/.lock");
  await holder.acquire();

  const deps = createDatastoreLockStatusDeps(
    unusedGlobalLock,
    customConfig("infra"),
    {
      listModels: () =>
        Promise.resolve([{ modelType: "@scope/type", modelId: "abc" }]),
      createLock,
    },
  );

  const locks = await deps.scanModelLocks();
  assertEquals(locks.map((l) => [l.lockKey, l.modelType, l.modelId]), [
    ["infra/data/@scope/type/abc/.lock", "@scope/type", "abc"],
  ]);
  assertEquals(
    getLockOperations().filter((op) => op.method === "inspect").map((op) =>
      op.lockKey
    ),
    ["infra/data/@scope/type/abc/.lock"],
  );
});

Deno.test("createDatastoreLockStatusDeps: inspects a model listed twice once", async () => {
  const { provider, getLockOperations } = createDatastoreTestContext();
  const createLock = (lockKey: string) => provider.createLock("", { lockKey });

  const holder = createLock(modelLockKey(undefined, "aws-ec2", "my-server"));
  await holder.acquire();

  const deps = createDatastoreLockStatusDeps(unusedGlobalLock, customConfig(), {
    listModels: () =>
      Promise.resolve([
        { modelType: "aws-ec2", modelId: "my-server" },
        { modelType: "aws-ec2", modelId: "my-server" },
      ]),
    createLock,
  });

  const locks = await deps.scanModelLocks();
  assertEquals(locks.length, 1);
  assertEquals(
    getLockOperations().filter((op) => op.method === "inspect").length,
    1,
  );
});

Deno.test("createDatastoreLockStatusDeps: a failed inspect fails the scan", async () => {
  const failing = {
    inspect: () => Promise.reject(new Error("AccessDenied")),
  } as unknown as DistributedLock;

  const deps = createDatastoreLockStatusDeps(unusedGlobalLock, customConfig(), {
    listModels: () =>
      Promise.resolve([{ modelType: "aws-ec2", modelId: "my-server" }]),
    createLock: () => failing,
  });

  await assertRejects(
    () => deps.scanModelLocks(),
    Error,
    "Could not inspect the lock for aws-ec2/my-server: AccessDenied",
  );
});

Deno.test("createDatastoreLockStatusDeps: a failed inspect stops further inspects", async () => {
  let inspects = 0;
  let inFlight = 0;
  const createLock = (lockKey: string) =>
    ({
      async inspect() {
        inspects++;
        inFlight++;
        try {
          if (lockKey.includes("server-00")) throw new Error("AccessDenied");
          // Still running when the failing inspect rejects.
          for (let i = 0; i < 5; i++) await Promise.resolve();
          return null;
        } finally {
          inFlight--;
        }
      },
    }) as unknown as DistributedLock;

  const models = Array.from({ length: 100 }, (_, i) => ({
    modelType: "aws-ec2",
    modelId: `server-${String(i).padStart(2, "0")}`,
  }));
  const deps = createDatastoreLockStatusDeps(unusedGlobalLock, customConfig(), {
    listModels: () => Promise.resolve(models),
    createLock,
  });

  await assertRejects(() => deps.scanModelLocks(), Error, "AccessDenied");
  // No inspect outlives the scan, and the failure stopped the rest.
  assertEquals(inFlight, 0);
  assertEquals(inspects, 16);
});

Deno.test("createDatastoreLockStatusDeps: bounds concurrent inspects and sorts results", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const createLock = (lockKey: string) =>
    ({
      async inspect() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
        return { ...sampleLockInfo, nonce: lockKey };
      },
    }) as unknown as DistributedLock;

  const models = Array.from({ length: 40 }, (_, i) => ({
    modelType: "aws-ec2",
    modelId: `server-${String(39 - i).padStart(2, "0")}`,
  }));
  const deps = createDatastoreLockStatusDeps(unusedGlobalLock, customConfig(), {
    listModels: () => Promise.resolve(models),
    createLock,
  });

  const locks = await deps.scanModelLocks();
  assertEquals(locks.length, 40);
  assertEquals(locks[0].modelId, "server-00");
  assertEquals(locks[39].modelId, "server-39");
  assertEquals(maxInFlight, 16);
});
