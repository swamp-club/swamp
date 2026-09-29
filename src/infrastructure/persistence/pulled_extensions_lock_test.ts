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
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, relative } from "@std/path";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { FileLock } from "./file_lock.ts";
import { swampPath } from "./paths.ts";
import {
  PULLED_EXTENSIONS_LOCK_KEY,
  PulledExtensionsLock,
} from "./pulled_extensions_lock.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-pulled-lock-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function lockFilePath(repoDir: string): string {
  return swampPath(repoDir, PULLED_EXTENSIONS_LOCK_KEY);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Runs a section that holds the lock until `release` resolves. */
function holdLock(
  lock: PulledExtensionsLock,
  repoDir: string,
  events: string[],
  name: string,
): { entered: Promise<void>; release: () => void; done: Promise<void> } {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const done = lock.withLock(repoDir, async () => {
    events.push(`${name}:start`);
    entered.resolve();
    await gate.promise;
    events.push(`${name}:end`);
  });
  return {
    entered: entered.promise,
    release: () => gate.resolve(),
    done,
  };
}

Deno.test("PulledExtensionsLock.withLock: two sections on one checkout run one after the other", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock();
    const events: string[] = [];

    const first = holdLock(lock, repoDir, events, "a");
    await first.entered;
    const second = lock.withLock(repoDir, () => {
      events.push("b:start");
      return Promise.resolve();
    });
    // The second section is queued: the lock reports busy while the
    // first holds it.
    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve()),
      { acquired: false },
    );

    first.release();
    await Promise.all([first.done, second]);
    assertEquals(events, ["a:start", "a:end", "b:start"]);
  });
});

Deno.test("PulledExtensionsLock.tryWithLock: busy while held, acquired after release", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock();
    const held = holdLock(lock, repoDir, [], "a");
    await held.entered;

    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve(1)),
      { acquired: false },
    );

    held.release();
    await held.done;
    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve(1)),
      { acquired: true, value: 1 },
    );
    assertEquals(await exists(lockFilePath(repoDir)), false);
  });
});

Deno.test("PulledExtensionsLock: the file lock alone serializes two processes", async () => {
  await withTempDir(async (repoDir) => {
    // Separate instances have separate in-process mutexes and leases,
    // standing in for two processes on one checkout.
    const processA = new PulledExtensionsLock();
    const processB = new PulledExtensionsLock();
    const events: string[] = [];

    const held = holdLock(processA, repoDir, events, "a");
    await held.entered;
    assertEquals(await exists(lockFilePath(repoDir)), true);
    assertEquals(
      await processB.tryWithLock(repoDir, () => Promise.resolve()),
      { acquired: false },
    );

    const waiting = processB.withLock(repoDir, () => {
      events.push("b:start");
      return Promise.resolve();
    });
    held.release();
    await Promise.all([held.done, waiting]);
    assertEquals(events, ["a:start", "a:end", "b:start"]);
  });
});

Deno.test("PulledExtensionsLock: a nested section under the lease runs inline", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock();
    const result = await lock.withLock(repoDir, async () => {
      const nested = await lock.withLock(repoDir, () => Promise.resolve("n"));
      const tried = await lock.tryWithLock(
        repoDir,
        () => Promise.resolve("t"),
      );
      return [nested, tried];
    });
    assertEquals(result, ["n", { acquired: true, value: "t" }]);
  });
});

Deno.test("PulledExtensionsLock: a lease survives a nested section for another checkout", async () => {
  await withTempDir(async (base) => {
    const repoA = join(base, "a");
    const repoB = join(base, "b");
    await Deno.mkdir(repoA);
    await Deno.mkdir(repoB);
    const lock = new PulledExtensionsLock();
    const result = await lock.withLock(
      repoA,
      () =>
        lock.withLock(
          repoB,
          () => lock.withLock(repoA, () => Promise.resolve("inline")),
        ),
    );
    assertEquals(result, "inline");
  });
});

Deno.test("PulledExtensionsLock: a promise that outlives its lease waits for the lock", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock();
    const events: string[] = [];
    const afterExit = Promise.withResolvers<void>();
    const attempting = Promise.withResolvers<void>();

    let escaped!: Promise<void>;
    await lock.withLock(repoDir, () => {
      // Created inside the lease, enters its section after the exit.
      escaped = (async () => {
        await afterExit.promise;
        attempting.resolve();
        // Same tick as the resolve above: an inline run would record
        // its event before the test resumes.
        await lock.withLock(repoDir, () => {
          events.push("escaped:start");
          return Promise.resolve();
        });
      })();
      return Promise.resolve();
    });

    const other = holdLock(lock, repoDir, events, "other");
    await other.entered;
    afterExit.resolve();
    await attempting.promise;
    assertEquals(events, ["other:start"]);
    other.release();
    await Promise.all([other.done, escaped]);
    assertEquals(events, ["other:start", "other:end", "escaped:start"]);
  });
});

Deno.test("PulledExtensionsLock: different checkouts do not block each other", async () => {
  await withTempDir(async (base) => {
    const repoA = join(base, "a");
    const repoB = join(base, "b");
    await Deno.mkdir(repoA);
    await Deno.mkdir(repoB);
    const lock = new PulledExtensionsLock();

    const held = holdLock(lock, repoA, [], "a");
    await held.entered;
    assertEquals(
      await lock.tryWithLock(repoB, () => Promise.resolve("b")),
      { acquired: true, value: "b" },
    );
    held.release();
    await held.done;
  });
});

Deno.test("PulledExtensionsLock: a relative and an absolute repo dir share one lock", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock();
    const held = holdLock(lock, repoDir, [], "a");
    await held.entered;
    assertEquals(
      await lock.tryWithLock(
        relative(Deno.cwd(), repoDir),
        () => Promise.resolve(),
      ),
      { acquired: false },
    );
    held.release();
    await held.done;
  });
});

Deno.test("PulledExtensionsLock.withLock: a throwing section releases both layers", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock();
    await assertRejects(
      () => lock.withLock(repoDir, () => Promise.reject(new Error("boom"))),
      Error,
      "boom",
    );
    assertEquals(await exists(lockFilePath(repoDir)), false);
    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve(1)),
      { acquired: true, value: 1 },
    );
  });
});

Deno.test("PulledExtensionsLock.withLock: a failed file-lock acquire frees the checkout for the next section", async () => {
  await withTempDir(async (repoDir) => {
    let calls = 0;
    const lock = new PulledExtensionsLock({
      createFileLock: (swampDir) => {
        calls++;
        if (calls === 1) {
          return {
            acquire: () =>
              Promise.reject(new Deno.errors.PermissionDenied("read-only")),
            tryAcquire: () => Promise.resolve(false),
            release: () => Promise.resolve(),
          };
        }
        return new FileLock(swampDir, {
          lockKey: PULLED_EXTENSIONS_LOCK_KEY,
        });
      },
    });

    await assertRejects(
      () => lock.withLock(repoDir, () => Promise.resolve()),
      Deno.errors.PermissionDenied,
    );
    assertEquals(await lock.withLock(repoDir, () => Promise.resolve(2)), 2);
  });
});

Deno.test("PulledExtensionsLock.withLock: a failed release still frees the checkout", async () => {
  await withTempDir(async (repoDir) => {
    let calls = 0;
    const lock = new PulledExtensionsLock({
      createFileLock: (swampDir) => {
        calls++;
        const real = new FileLock(swampDir, {
          lockKey: PULLED_EXTENSIONS_LOCK_KEY,
        });
        if (calls > 1) return real;
        return {
          acquire: () => real.acquire(),
          tryAcquire: () => real.tryAcquire(),
          release: async () => {
            await real.release();
            throw new Error("release failed");
          },
        };
      },
    });

    await assertRejects(
      () => lock.withLock(repoDir, () => Promise.resolve()),
      Error,
      "release failed",
    );
    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve(3)),
      { acquired: true, value: 3 },
    );
  });
});

Deno.test("PulledExtensionsLock.withLock: the timeout names the lock file and its holder", async () => {
  await withTempDir(async (repoDir) => {
    const holder = new FileLock(swampPath(repoDir), {
      lockKey: PULLED_EXTENSIONS_LOCK_KEY,
      ttlMs: 60_000,
    });
    await holder.acquire();
    try {
      const lock = new PulledExtensionsLock({
        createFileLock: (swampDir) =>
          new FileLock(swampDir, {
            lockKey: PULLED_EXTENSIONS_LOCK_KEY,
            ttlMs: 60_000,
            retryIntervalMs: 20,
            maxWaitMs: 100,
          }),
      });
      const error = await assertRejects(
        () => lock.withLock(repoDir, () => Promise.resolve()),
        LockTimeoutError,
      );
      assertStringIncludes(error.message, lockFilePath(repoDir));
      assertStringIncludes(error.message, "pulled extensions");
      assertStringIncludes(error.message, `pid ${Deno.pid}`);
      assert(error.holder !== null);
    } finally {
      await holder.release();
    }
  });
});

Deno.test("PulledExtensionsLock.withLock: a waiter behind a section in this process times out", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock({ maxWaitMs: 100 });
    const held = holdLock(lock, repoDir, [], "a");
    await held.entered;

    const error = await assertRejects(
      () => lock.withLock(repoDir, () => Promise.resolve()),
      LockTimeoutError,
    );
    assertStringIncludes(error.message, "this swamp process");
    assertStringIncludes(error.message, lockFilePath(repoDir));
    // The abandoned place does not count as a holder.
    held.release();
    await held.done;
    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve(1)),
      { acquired: true, value: 1 },
    );
  });
});

Deno.test("PulledExtensionsLock.withLock: a section queued behind a timed-out waiter still waits for the holder", async () => {
  await withTempDir(async (repoDir) => {
    const lock = new PulledExtensionsLock({ maxWaitMs: 100 });
    const events: string[] = [];
    const held = holdLock(lock, repoDir, events, "holder");
    await held.entered;
    await assertRejects(
      () => lock.withLock(repoDir, () => Promise.resolve()),
      LockTimeoutError,
    );

    const next = lock.withLock(repoDir, () => {
      events.push("next:start");
      return Promise.resolve();
    });
    assertEquals(
      await lock.tryWithLock(repoDir, () => Promise.resolve()),
      { acquired: false },
    );
    held.release();
    await Promise.all([held.done, next]);
    assertEquals(events, ["holder:start", "holder:end", "next:start"]);
  });
});
