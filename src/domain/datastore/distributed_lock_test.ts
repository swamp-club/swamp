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
  assertStringIncludes,
} from "@std/assert";
import { UserError } from "../errors.ts";
import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
  toCoreLockTimeoutError,
  withCoreLockErrors,
} from "./distributed_lock.ts";

Deno.test("LockTimeoutError: includes holder info when available", () => {
  const error = new LockTimeoutError(
    ".datastore.lock",
    {
      holder: "paul@pauls-macbook",
      hostname: "pauls-macbook",
      pid: 12345,
      acquiredAt: "2026-03-10T12:00:00.000Z",
      ttlMs: 30000,
    },
    60000,
  );

  assertEquals(error.name, "LockTimeoutError");
  assertStringIncludes(error.message, "paul@pauls-macbook");
  assertStringIncludes(error.message, "12345");
  assertStringIncludes(error.message, "60000");
  assertEquals(error.lockKey, ".datastore.lock");
  assertEquals(error.waitedMs, 60000);
  assertEquals(error.holder?.pid, 12345);
});

Deno.test("LockTimeoutError: works without holder info", () => {
  const error = new LockTimeoutError(
    ".datastore.lock",
    null,
    5000,
  );

  assertEquals(error.name, "LockTimeoutError");
  assertStringIncludes(error.message, ".datastore.lock");
  assertStringIncludes(error.message, "5000");
  assertEquals(error.holder, null);
});

Deno.test("LockTimeoutError: is an instance of Error and UserError", () => {
  const error = new LockTimeoutError("key", null, 1000);
  assertEquals(error instanceof Error, true);
  assertEquals(error instanceof UserError, true);
  assertEquals(error instanceof LockTimeoutError, true);
});

Deno.test("LockTimeoutError: global lock key includes namespace hint", () => {
  const error = new LockTimeoutError(".datastore.lock", null, 5000);
  assertStringIncludes(error.message, "swamp datastore namespace set");
  assertStringIncludes(error.message, "swamp datastore namespace migrate");
});

Deno.test("LockTimeoutError: filesystem full path omits namespace hint (display keys only)", () => {
  const error = new LockTimeoutError(
    "/home/user/.swamp/.datastore.lock",
    null,
    5000,
  );
  assertEquals(error.message.includes("namespace set"), false);
});

Deno.test("LockTimeoutError: namespaced display key omits namespace hint", () => {
  const error = new LockTimeoutError("infra/.datastore.lock", null, 5000);
  assertEquals(error.message.includes("namespace set"), false);
});

Deno.test("LockTimeoutError: namespaced filesystem path omits namespace hint", () => {
  const error = new LockTimeoutError(
    "/home/user/.swamp/infra/.datastore.lock",
    null,
    5000,
  );
  assertEquals(error.message.includes("namespace set"), false);
});

/** Mirrors the error the S3 and GCS datastore extensions throw on timeout. */
class ExtensionLockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";
  readonly code = "LOCK_TIMEOUT" as const;
  readonly retryable = true as const;

  constructor(
    public readonly lockKey: string,
    public readonly holder: LockInfo | null,
    public readonly waitedMs: number,
  ) {
    super(`Lock "${lockKey}" [extension] — timed out after ${waitedMs}ms`);
  }
}

const HOLDER: LockInfo = {
  holder: "sam@host",
  hostname: "host",
  pid: 4242,
  acquiredAt: "2026-09-28T12:00:00.000Z",
  ttlMs: 30000,
};

Deno.test("toCoreLockTimeoutError: returns a core LockTimeoutError unchanged", () => {
  const original = new LockTimeoutError("k", null, 10);
  assertStrictEquals(toCoreLockTimeoutError(original), original);
});

Deno.test("toCoreLockTimeoutError: translates an extension LOCK_TIMEOUT error", () => {
  const original = new ExtensionLockTimeoutError("data/m/.lock", HOLDER, 6484);
  const translated = toCoreLockTimeoutError(original);

  assertInstanceOf(translated, LockTimeoutError);
  assertInstanceOf(translated, UserError);
  assertEquals(translated.code, "lock_timeout");
  assertEquals(translated.lockKey, "data/m/.lock");
  assertEquals(translated.holder, HOLDER);
  assertEquals(translated.waitedMs, 6484);
  assertStringIncludes(translated.message, "sam@host");
  assertStringIncludes(translated.message, "6484ms");
  assertStrictEquals(translated.cause, original);
});

Deno.test("toCoreLockTimeoutError: matches the code in any case", () => {
  const translated = toCoreLockTimeoutError({
    code: "Lock_Timeout",
    lockKey: "k",
    waitedMs: 5,
    holder: null,
  });
  assertInstanceOf(translated, LockTimeoutError);
});

Deno.test("toCoreLockTimeoutError: translated global lock key keeps the namespace hint", () => {
  const translated = toCoreLockTimeoutError(
    new ExtensionLockTimeoutError(".datastore.lock", null, 60000),
  );
  assertInstanceOf(translated, LockTimeoutError);
  assertStringIncludes(translated.message, "swamp datastore namespace set");
});

Deno.test("toCoreLockTimeoutError: keeps the original message when lock fields are missing", () => {
  const original = Object.assign(new Error("backend gave up waiting"), {
    code: "LOCK_TIMEOUT",
  });
  const translated = toCoreLockTimeoutError(original);

  assertInstanceOf(translated, LockTimeoutError);
  assertEquals(translated.message, "backend gave up waiting");
  assertEquals(translated.code, "lock_timeout");
});

Deno.test("toCoreLockTimeoutError: drops a malformed holder", () => {
  const translated = toCoreLockTimeoutError({
    code: "LOCK_TIMEOUT",
    lockKey: "k",
    waitedMs: 5,
    holder: { holder: 7 },
  });
  assertInstanceOf(translated, LockTimeoutError);
  assertEquals(translated.holder, null);
});

Deno.test("toCoreLockTimeoutError: returns null for unrelated errors", () => {
  assertEquals(toCoreLockTimeoutError(new Error("boom")), null);
  assertEquals(
    toCoreLockTimeoutError(new UserError("nope", "timeout")),
    null,
  );
  assertEquals(toCoreLockTimeoutError("LOCK_TIMEOUT"), null);
  assertEquals(toCoreLockTimeoutError(null), null);
});

function fakeLock(overrides: Partial<DistributedLock>): DistributedLock {
  return {
    acquire: () => Promise.resolve(),
    release: () => Promise.resolve(),
    withLock: (fn) => fn(),
    inspect: () => Promise.resolve(null),
    forceRelease: () => Promise.resolve(false),
    ...overrides,
  };
}

Deno.test("withCoreLockErrors: acquire rejects with the core LockTimeoutError", async () => {
  const lock = withCoreLockErrors(fakeLock({
    acquire: () =>
      Promise.reject(new ExtensionLockTimeoutError("k", HOLDER, 3000)),
  }));

  const error = await assertRejects(() => lock.acquire(), LockTimeoutError);
  assertEquals(error.code, "lock_timeout");
});

Deno.test("withCoreLockErrors: withLock rejects with the core LockTimeoutError", async () => {
  const lock = withCoreLockErrors(fakeLock({
    withLock: () =>
      Promise.reject(new ExtensionLockTimeoutError("k", null, 3000)),
  }));

  await assertRejects(
    () => lock.withLock(() => Promise.resolve("never")),
    LockTimeoutError,
  );
});

Deno.test("withCoreLockErrors: passes other errors through unchanged", async () => {
  const original = new Error("network down");
  const lock = withCoreLockErrors(fakeLock({
    acquire: () => Promise.reject(original),
  }));

  const error = await assertRejects(() => lock.acquire());
  assertStrictEquals(error, original);
});

Deno.test("withCoreLockErrors: delegates release, inspect, forceRelease and withLock results", async () => {
  const calls: string[] = [];
  const lock = withCoreLockErrors(fakeLock({
    release: () => {
      calls.push("release");
      return Promise.resolve();
    },
    inspect: () => {
      calls.push("inspect");
      return Promise.resolve(HOLDER);
    },
    forceRelease: (nonce) => {
      calls.push(`forceRelease:${nonce}`);
      return Promise.resolve(true);
    },
  }));

  await lock.release();
  assertEquals(await lock.inspect(), HOLDER);
  assertEquals(await lock.forceRelease("n-1"), true);
  assertEquals(await lock.withLock(() => Promise.resolve(42)), 42);
  assertEquals(calls, ["release", "inspect", "forceRelease:n-1"]);
});
