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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../logging/logger.ts";
import {
  flushDatastoreSync,
  flushDatastoreSyncNamed,
  getRegisteredLockKeys,
  GLOBAL_LOCK_KEY,
  registerDatastoreSync,
  registerDatastoreSyncNamed,
} from "./datastore_sync_coordinator.ts";
import type { DistributedLock } from "../../domain/datastore/distributed_lock.ts";
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  resolveSyncTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncOptions } from "../../domain/datastore/datastore_sync_service.ts";
import { SyncTimeoutError } from "../../domain/datastore/datastore_sync_service.ts";
import { UserError } from "../../domain/errors.ts";

// Initialize logging for tests
await initializeLogging({});

/** Fake lock that tracks acquire/release calls. */
class FakeLock implements DistributedLock {
  acquired = false;
  released = false;
  acquireCount = 0;
  releaseCount = 0;

  async acquire(): Promise<void> {
    this.acquired = true;
    this.acquireCount++;
    await Promise.resolve();
  }

  async release(): Promise<void> {
    this.released = true;
    this.releaseCount++;
    await Promise.resolve();
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release();
    }
  }

  async inspect() {
    await Promise.resolve();
    return null;
  }

  async forceRelease(_nonce: string) {
    await Promise.resolve();
    return false;
  }
}

Deno.test("registerDatastoreSync uses GLOBAL_LOCK_KEY", async () => {
  const lock = new FakeLock();
  await registerDatastoreSync({ lock });

  const keys = getRegisteredLockKeys();
  assertEquals(keys.includes(GLOBAL_LOCK_KEY), true);
  assertEquals(lock.acquired, true);

  await flushDatastoreSync();
  assertEquals(lock.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("registerDatastoreSyncNamed registers with custom key", async () => {
  const lock = new FakeLock();
  await registerDatastoreSyncNamed("model/aws-ec2/my-server", { lock });

  const keys = getRegisteredLockKeys();
  assertEquals(keys.includes("model/aws-ec2/my-server"), true);
  assertEquals(lock.acquired, true);

  await flushDatastoreSyncNamed("model/aws-ec2/my-server");
  assertEquals(lock.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("multiple named entries can coexist", async () => {
  const lock1 = new FakeLock();
  const lock2 = new FakeLock();
  const lock3 = new FakeLock();

  await registerDatastoreSyncNamed("model/a", { lock: lock1 });
  await registerDatastoreSyncNamed("model/b", { lock: lock2 });
  await registerDatastoreSyncNamed("model/c", { lock: lock3 });

  assertEquals(getRegisteredLockKeys().length, 3);
  assertEquals(lock1.acquired, true);
  assertEquals(lock2.acquired, true);
  assertEquals(lock3.acquired, true);

  // Flush one
  await flushDatastoreSyncNamed("model/b");
  assertEquals(lock2.released, true);
  assertEquals(getRegisteredLockKeys().length, 2);

  // Flush all remaining
  await flushDatastoreSync();
  assertEquals(lock1.released, true);
  assertEquals(lock3.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("flushDatastoreSyncNamed is no-op for unknown key", async () => {
  await flushDatastoreSyncNamed("nonexistent");
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("flushDatastoreSync flushes all entries", async () => {
  const globalLock = new FakeLock();
  const modelLock = new FakeLock();

  await registerDatastoreSync({ lock: globalLock });
  await registerDatastoreSyncNamed("model/x", { lock: modelLock });

  assertEquals(getRegisteredLockKeys().length, 2);

  await flushDatastoreSync();
  assertEquals(globalLock.released, true);
  assertEquals(modelLock.released, true);
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("registerDatastoreSync enriches pullChanged failure with SDK metadata", async () => {
  const opaqueError = Object.assign(new Error("UnknownError"), {
    name: "UnknownError",
    Code: "AccessDenied",
    $metadata: { httpStatusCode: 403, requestId: "TEST-REQ-123" },
  });

  const failingService = {
    pullChanged: () => {
      throw opaqueError;
    },
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };

  const thrown = await assertRejects(
    () =>
      registerDatastoreSync({
        service: failingService,
        label: "@test/syncfail",
      }),
    Error,
  );

  // `.message` carries the enriched summary so downstream renderers
  // (buildErrorJson, createJsonErrorSink) surface the rich information
  // without any presentation-layer changes.
  assertStringIncludes(thrown.message, "@test/syncfail pull failed");
  assertStringIncludes(thrown.message, "HTTP 403");
  assertStringIncludes(thrown.message, "requestId=TEST-REQ-123");
  assertStringIncludes(thrown.message, "code=AccessDenied");

  // `.cause` preserves the original error object so a later renderer
  // improvement can walk the cause chain for any future consumer.
  assertEquals(thrown.cause, opaqueError);
});

Deno.test("flushDatastoreSync swallows pushChanged failures (warn-only)", async () => {
  const failingService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => {
      throw Object.assign(new Error("UnknownError"), {
        $metadata: { httpStatusCode: 500 },
      });
    },
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSync({
    service: failingService,
    label: "@test/syncfail",
  });

  // Must NOT throw — the coordinator's push path is intentionally
  // warn-and-swallow so a successful command doesn't fail on cleanup.
  await flushDatastoreSync();
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("SyncTimeoutError is a UserError so the CLI error boundary renders message only", () => {
  // If this regresses, renderError's else-branch fires and dumps a stack
  // trace that buries the actionable `swamp datastore lock release --force`
  // hint — see swamp#1216 review feedback.
  const err = new SyncTimeoutError("@test/x", "push", 1000);
  assertEquals(err instanceof UserError, true);
});

Deno.test("flushDatastoreSync: hanging pushChanged surfaces SyncTimeoutError within window", async () => {
  const hangingService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => new Promise<number>(() => {}), // never resolves
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSync({
    service: hangingService,
    label: "@test/hang",
    syncTimeoutMs: 120,
  });

  const started = Date.now();
  const err = await assertRejects(
    () => flushDatastoreSync(),
    SyncTimeoutError,
  );
  const elapsed = Date.now() - started;

  // Fires within configured window + modest slack — not indefinitely.
  assertEquals(elapsed < 1_000, true, `timed out after ${elapsed}ms`);
  assertEquals(err.label, "@test/hang");
  assertEquals(err.direction, "push");
  assertEquals(err.timeoutMs, 120);
  // Actionable escape hatch in the message.
  assertStringIncludes(err.message, "swamp datastore lock release --force");
  // Coordinator state is clean after the throw.
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("flushDatastoreSync: signal-compliant extension aborts cooperatively", async () => {
  let observedSignal: AbortSignal | undefined;
  const cooperativeService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: (options?: { signal?: AbortSignal }) =>
      new Promise<number>((_, reject) => {
        observedSignal = options?.signal;
        options?.signal?.addEventListener("abort", () => {
          reject(
            new DOMException("The operation was aborted.", "AbortError"),
          );
        }, { once: true });
      }),
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSync({
    service: cooperativeService,
    label: "@test/cooperative",
    syncTimeoutMs: 120,
  });

  // Should surface SyncTimeoutError (from the AbortController.abort(reason)),
  // not the cooperative extension's AbortError.
  const err = await assertRejects(
    () => flushDatastoreSync(),
    SyncTimeoutError,
  );
  assertEquals(err.direction, "push");
  assertEquals(observedSignal !== undefined, true);
  assertEquals(observedSignal?.aborted, true);
});

Deno.test("flushDatastoreSync: releases lock even when push times out", async () => {
  const hangingService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => new Promise<number>(() => {}),
    markDirty: () => Promise.resolve(),
  };
  const lock = new FakeLock();

  await registerDatastoreSync({
    service: hangingService,
    lock,
    label: "@test/hang-with-lock",
    syncTimeoutMs: 100,
  });

  await assertRejects(() => flushDatastoreSync(), SyncTimeoutError);

  // Lock MUST be released even on timeout — otherwise the next run
  // walks into a stale lock, which is the bug we're fixing.
  assertEquals(lock.released, true);
  assertEquals(lock.releaseCount, 1);
});

Deno.test("registerDatastoreSync: hanging pullChanged surfaces SyncTimeoutError", async () => {
  const hangingService = {
    pullChanged: () => new Promise<number>(() => {}),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };

  // Pull-path timeouts throw SyncTimeoutError directly (not wrapped) so
  // they render cleanly at the top-level CLI error boundary.
  const err = await assertRejects(
    () =>
      registerDatastoreSync({
        service: hangingService,
        label: "@test/hangpull",
        syncTimeoutMs: 120,
      }),
    SyncTimeoutError,
  );
  assertEquals(err.direction, "pull");
  assertEquals(err.timeoutMs, 120);
  // Register does not persist state on failure, but be defensive.
  await flushDatastoreSync();
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("registerDatastoreSyncNamed: pull timeout cleans up entry and releases lock", async () => {
  // Regression guard: if this fails, the runCli error handler at
  // cli/mod.ts will hit the hung entry again via flushDatastoreSync,
  // doubling the user-visible timeout wait and shadowing the original
  // error (see swamp#1216 review — double-timeout bug).
  const hanging = {
    pullChanged: () => new Promise<number>(() => {}),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  const lock = new FakeLock();

  await assertRejects(
    () =>
      registerDatastoreSyncNamed("entry-cleanup", {
        service: hanging,
        lock,
        label: "@test/cleanup",
        syncTimeoutMs: 100,
      }),
    SyncTimeoutError,
  );

  // Entry removed from the map — a subsequent flushDatastoreSync() in
  // the outer error handler must not re-encounter this hung service.
  assertEquals(getRegisteredLockKeys().includes("entry-cleanup"), false);
  // Lock released so the next run isn't stranded.
  assertEquals(lock.released, true);
  assertEquals(lock.releaseCount, 1);

  // And confirm: a flush right now is a clean no-op, not another hang.
  await flushDatastoreSync();
});

Deno.test("registerDatastoreSyncNamed: lock acquire failure removes entry", async () => {
  // Regression guard symmetrical to the pull cleanup test — if lock
  // acquire fails, the entry must be removed so the outer error handler's
  // flushDatastoreSync() call doesn't later invoke push on this service.
  const service = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  const failingLock = {
    async acquire() {
      await Promise.resolve();
      throw new Error("lock acquire blew up");
    },
    async release() {
      await Promise.resolve();
    },
    withLock<T>(fn: () => Promise<T>) {
      return fn();
    },
    async inspect() {
      await Promise.resolve();
      return null;
    },
    async forceRelease(_n: string) {
      await Promise.resolve();
      return false;
    },
  };

  await assertRejects(
    () =>
      registerDatastoreSyncNamed("lock-fail", {
        service,
        lock: failingLock,
        label: "@test/lockfail",
      }),
    Error,
    "lock acquire blew up",
  );

  assertEquals(getRegisteredLockKeys().includes("lock-fail"), false);
  await flushDatastoreSync();
});

Deno.test("flushDatastoreSync: normal settlement within timeout does not throw", async () => {
  const fastService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(3),
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSync({
    service: fastService,
    label: "@test/fast",
    syncTimeoutMs: 60_000,
  });

  await flushDatastoreSync();
  assertEquals(getRegisteredLockKeys().length, 0);
  // If the setTimeout wasn't cleared, Deno's test runner flags the leaked
  // timer and this test fails — implicit coverage of cleanup.
});

Deno.test("resolveSyncTimeoutMs: config field overrides env and default", () => {
  const cfg = {
    type: "@test/store",
    config: {},
    datastorePath: "/tmp/x",
    syncTimeoutMs: 555,
  };
  // Direct import rather than end-to-end coordinator test — proves the
  // config→timeout resolver plumbing independently of runBoundedSync.
  assertEquals(resolveSyncTimeoutMs(cfg), 555);
});

Deno.test("resolveSyncTimeoutMs: env var used when config field absent", () => {
  const cfg = {
    type: "@test/store",
    config: {},
    datastorePath: "/tmp/x",
  };
  Deno.env.set("SWAMP_DATASTORE_SYNC_TIMEOUT_MS", "4200");
  try {
    assertEquals(resolveSyncTimeoutMs(cfg), 4200);
  } finally {
    Deno.env.delete("SWAMP_DATASTORE_SYNC_TIMEOUT_MS");
  }
});

Deno.test("resolveSyncTimeoutMs: invalid env falls back to default", () => {
  const cfg = {
    type: "@test/store",
    config: {},
    datastorePath: "/tmp/x",
  };
  Deno.env.set("SWAMP_DATASTORE_SYNC_TIMEOUT_MS", "not-a-number");
  try {
    assertEquals(resolveSyncTimeoutMs(cfg), DEFAULT_SYNC_TIMEOUT_MS);
  } finally {
    Deno.env.delete("SWAMP_DATASTORE_SYNC_TIMEOUT_MS");
  }
});

Deno.test("flushDatastoreSync: one entry's timeout still flushes other entries", async () => {
  // Regression guard: before the loop was wrapped in try/catch, a
  // SyncTimeoutError from one entry would abort the for-loop and strand
  // later entries with held locks — recreating the stuck-lock bug this
  // coordinator is hardened against.
  const hanging = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => new Promise<number>(() => {}),
    markDirty: () => Promise.resolve(),
  };
  const fast = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  const lockA = new FakeLock();
  const lockB = new FakeLock();
  const lockC = new FakeLock();

  await registerDatastoreSyncNamed("entry-a", {
    service: hanging,
    lock: lockA,
    label: "@test/a-hangs",
    syncTimeoutMs: 100,
  });
  await registerDatastoreSyncNamed("entry-b", {
    service: fast,
    lock: lockB,
    label: "@test/b-fast",
    syncTimeoutMs: 5_000,
  });
  await registerDatastoreSyncNamed("entry-c", {
    service: fast,
    lock: lockC,
    label: "@test/c-fast",
    syncTimeoutMs: 5_000,
  });

  await assertRejects(() => flushDatastoreSync(), SyncTimeoutError);

  // All three locks MUST have been released — the timeout on entry A
  // should not strand B and C.
  assertEquals(lockA.released, true, "entry-a lock released");
  assertEquals(lockB.released, true, "entry-b lock released");
  assertEquals(lockC.released, true, "entry-c lock released");
  assertEquals(getRegisteredLockKeys().length, 0);
});

Deno.test("flushDatastoreSync: config timeout is honored end-to-end", async () => {
  const hangingService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => new Promise<number>(() => {}),
    markDirty: () => Promise.resolve(),
  };
  const cfg = {
    type: "@test/integration",
    config: {},
    datastorePath: "/tmp/x",
    syncTimeoutMs: 150,
  };

  await registerDatastoreSync({
    service: hangingService,
    label: cfg.type,
    syncTimeoutMs: resolveSyncTimeoutMs(cfg),
  });

  const started = Date.now();
  await assertRejects(() => flushDatastoreSync(), SyncTimeoutError);
  const elapsed = Date.now() - started;
  // Proves config → resolveSyncTimeoutMs → registerDatastoreSync → runBoundedSync.
  assertEquals(elapsed < 1_000, true, `timed out after ${elapsed}ms`);
});

// --- Namespace threading ---

Deno.test("registerDatastoreSyncNamed: namespace is passed to pullChanged", async () => {
  let pullOptions: DatastoreSyncOptions | undefined;
  const service = {
    pullChanged: (opts?: DatastoreSyncOptions) => {
      pullOptions = opts;
      return Promise.resolve(0);
    },
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSyncNamed("ns-pull", {
    service,
    label: "@test/ns-pull",
    namespace: "infra",
  });

  assertEquals(pullOptions?.namespace, "infra");

  await flushDatastoreSyncNamed("ns-pull");
});

Deno.test("flushDatastoreSyncNamed: namespace is passed to pushChanged", async () => {
  let pushOptions: DatastoreSyncOptions | undefined;
  const service = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: (opts?: DatastoreSyncOptions) => {
      pushOptions = opts;
      return Promise.resolve(0);
    },
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSyncNamed("ns-push", {
    service,
    label: "@test/ns-push",
    namespace: "security",
  });

  await flushDatastoreSyncNamed("ns-push");

  assertEquals(pushOptions?.namespace, "security");
});

Deno.test("registerDatastoreSyncNamed: no namespace means pull/push omit it", async () => {
  let pullOptions: DatastoreSyncOptions | undefined;
  let pushOptions: DatastoreSyncOptions | undefined;
  const service = {
    pullChanged: (opts?: DatastoreSyncOptions) => {
      pullOptions = opts;
      return Promise.resolve(0);
    },
    pushChanged: (opts?: DatastoreSyncOptions) => {
      pushOptions = opts;
      return Promise.resolve(0);
    },
    markDirty: () => Promise.resolve(),
  };

  await registerDatastoreSyncNamed("no-ns", {
    service,
    label: "@test/no-ns",
  });

  assertEquals(pullOptions?.namespace, undefined);

  await flushDatastoreSyncNamed("no-ns");

  assertEquals(pushOptions?.namespace, undefined);
});

// --- Stream-0 regression net: SIGINT releases locks within 5s deadline ---

Deno.test({
  name:
    "datastore sync SIGINT handler releases all held locks within the 5s force-exit deadline (POSIX)",
  // The SIGINT handler in datastore_sync_coordinator.ts calls
  // Deno.exit(130), which means we can't exercise it in-process — we
  // must spawn a child Deno process, register a lock, raise SIGINT to
  // self, and assert the child exited 130 within ~5.5s. The handler
  // wraps releases in a 5s force-exit timeout (`setTimeout(...,
  // 5_000)`); a refactor that drops or extends that bound will fail.
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Resolve the absolute path to datastore_sync_coordinator.ts so the
    // child Deno can import it via a file:// URL.
    const coordinatorUrl = new URL(
      "./datastore_sync_coordinator.ts",
      import.meta.url,
    ).href;

    const program = `
      import {
        registerDatastoreSyncNamed,
      } from "${coordinatorUrl}";

      const lock = {
        acquired: false,
        released: false,
        async acquire() { this.acquired = true; },
        async release() { this.released = true; },
        async withLock(fn) { await this.acquire(); try { return await fn(); } finally { await this.release(); } },
        async inspect() { return null; },
        async forceRelease() { return false; },
      };

      await registerDatastoreSyncNamed("stream-0-fixture", { lock });

      // Signal self after a short delay so the registration is fully in
      // place when the handler fires.
      setTimeout(() => {
        Deno.kill(Deno.pid, "SIGINT");
      }, 50);

      // Block forever — the SIGINT handler's Deno.exit(130) is what
      // ends this process.
      await new Promise(() => {});
    `;

    const start = Date.now();
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "-"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(program));
    } finally {
      await writer.close();
    }

    const status = await Promise.race([
      child.status,
      new Promise<{ code: number; success: boolean; signal: null }>(
        (_, reject) => {
          setTimeout(
            () => reject(new Error("child did not exit within 5.5s deadline")),
            5_500,
          );
        },
      ),
    ]);
    const elapsed = Date.now() - start;

    // Drain pipes so the test sanitizer doesn't complain about open streams.
    await child.stdout.cancel();
    await child.stderr.cancel();

    // The handler's contract: releases run, then Deno.exit(130). If the
    // handler hung past the force-exit fallback, the inner setTimeout
    // would still bring this in under 5s — so the 5.5s race is the
    // outer guard.
    assertEquals(
      status.code,
      130,
      `expected SIGINT handler to exit 130; got ${status.code} after ${elapsed}ms`,
    );
    assertEquals(
      elapsed < 5_500,
      true,
      `expected exit within 5.5s; took ${elapsed}ms`,
    );
  },
});
