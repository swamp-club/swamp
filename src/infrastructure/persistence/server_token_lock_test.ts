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
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { SEPARATOR } from "@std/path";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { parseModelLockKey } from "../../libswamp/datastores/lock.ts";
import {
  MODEL_LOCK_MAX_BACKOFF_MS,
  MODEL_LOCK_RETRY_INTERVAL_MS,
} from "../../cli/repo_context.ts";
import type { FileLock } from "./file_lock.ts";
import {
  createServerTokenLock,
  SERVER_TOKEN_LOCK_MAX_BACKOFF_MS,
  SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS,
  serverTokenLockKey,
  withServerTokenLock,
} from "./server_token_lock.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

function filesystemDatastore(dir: string): DatastoreConfig {
  return { type: "filesystem", path: dir } as DatastoreConfig;
}

Deno.test("server token lock: retry settings match the per-model lock's", () => {
  assertEquals(
    SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS,
    MODEL_LOCK_RETRY_INTERVAL_MS,
  );
  assertEquals(SERVER_TOKEN_LOCK_MAX_BACKOFF_MS, MODEL_LOCK_MAX_BACKOFF_MS);
});

// ── serverTokenLockKey ────────────────────────────────────────────────

Deno.test("serverTokenLockKey: one stable key per token name", async () => {
  const key = await serverTokenLockKey(undefined, "ci-deploy");
  assertEquals(key, await serverTokenLockKey(undefined, "ci-deploy"));
  assertNotEquals(key, await serverTokenLockKey(undefined, "ci-deploy-2"));
  assertMatch(key, /^server-token-locks\/[0-9a-f]{64}\/\.lock$/);
});

Deno.test("serverTokenLockKey: with namespace", async () => {
  const bare = await serverTokenLockKey(undefined, "ci-deploy");
  assertEquals(await serverTokenLockKey("infra", "ci-deploy"), `infra/${bare}`);
});

Deno.test("serverTokenLockKey: the name never reaches the key", async () => {
  // The name comes from a client; a first mint has no definition to have
  // validated it.
  for (const name of ["../../outside", "a/b", "..", "x\\y", "@scope/tok"]) {
    assertMatch(
      await serverTokenLockKey(undefined, name),
      /^server-token-locks\/[0-9a-f]{64}\/\.lock$/,
    );
  }
});

Deno.test("serverTokenLockKey: is not mistaken for a per-model lock", async () => {
  const key = await serverTokenLockKey(undefined, "ci-deploy");
  assertEquals(parseModelLockKey(key.replaceAll("/", SEPARATOR)), null);
});

Deno.test("createServerTokenLock - uses the short retry settings on a filesystem datastore", async () => {
  await withTempDir(async (dir) => {
    const datastoreConfig = filesystemDatastore(dir);
    const lock = await createServerTokenLock(datastoreConfig, "ci-deploy");

    assertEquals(await lock.inspect(), null);
    assertEquals(
      (lock as FileLock).retryIntervalMs,
      SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS,
    );
    assertEquals(
      (lock as FileLock).maxBackoffMs,
      SERVER_TOKEN_LOCK_MAX_BACKOFF_MS,
    );
  });
});

Deno.test("withServerTokenLock - holds the token's lock for the callback and releases it after", async () => {
  await withTempDir(async (dir) => {
    const datastoreConfig = filesystemDatastore(dir);
    const name = `tok-${crypto.randomUUID()}`;
    const observer = await createServerTokenLock(datastoreConfig, name);
    const other = await createServerTokenLock(datastoreConfig, `${name}-2`);

    const result = await withServerTokenLock(
      datastoreConfig,
      name,
      async () => {
        assertNotEquals(await observer.inspect(), null);
        // Another token's lock is a different lock.
        assertEquals(await other.inspect(), null);
        return "done";
      },
    );

    assertEquals(result, "done");
    assertEquals(await observer.inspect(), null);
  });
});

Deno.test("withServerTokenLock - releases the lock when the callback throws", async () => {
  await withTempDir(async (dir) => {
    const datastoreConfig = filesystemDatastore(dir);
    const name = `tok-${crypto.randomUUID()}`;
    await assertRejects(
      () =>
        withServerTokenLock(datastoreConfig, name, () => {
          throw new Error("mint failed");
        }),
      Error,
      "mint failed",
    );
    const observer = await createServerTokenLock(datastoreConfig, name);
    assertEquals(await observer.inspect(), null);
  });
});

Deno.test("withServerTokenLock - a second writer of the same name runs after the first", async () => {
  await withTempDir(async (dir) => {
    const datastoreConfig = filesystemDatastore(dir);
    const name = `tok-${crypto.randomUUID()}`;
    const events: string[] = [];
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();

    const first = withServerTokenLock(datastoreConfig, name, async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstEntered.promise;
    const second = withServerTokenLock(datastoreConfig, name, () => {
      events.push("second");
      return Promise.resolve();
    });
    releaseFirst.resolve();
    await Promise.all([first, second]);

    assertEquals(events, ["first:start", "first:end", "second"]);
  });
});
