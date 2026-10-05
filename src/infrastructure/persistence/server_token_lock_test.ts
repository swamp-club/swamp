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
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { FileLock } from "./file_lock.ts";
import {
  createServerTokenLock,
  SERVER_TOKEN_LOCK_MAX_BACKOFF_MS,
  SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS,
  serverTokenLockKey,
  serverTokenLockName,
  withServerTokenLock,
} from "./server_token_lock.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

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

Deno.test("serverTokenLockKey: sits outside data/, where per-model locks live", async () => {
  // parseModelLockKey accepts only keys under data/, so the per-model lock
  // scan never counts this one.
  const key = await serverTokenLockKey(undefined, "ci-deploy");
  assertEquals(key.startsWith("data/"), false);
  assertEquals(
    (await serverTokenLockKey("infra", "ci-deploy")).includes(
      "/data/",
    ),
    false,
  );
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

Deno.test("withServerTokenLock - a timeout names the token, not the digest in its key", async () => {
  await withTempDir(async (dir) => {
    const datastoreConfig = filesystemDatastore(dir);
    const name = `tok-${crypto.randomUUID()}`;
    const holder = await createServerTokenLock(datastoreConfig, name);
    let ran = false;

    await holder.acquire();
    try {
      const error = await assertRejects(
        () =>
          withMockedEnv(
            { SWAMP_LOCK_TIMEOUT_MS: "200" },
            () =>
              withServerTokenLock(datastoreConfig, name, () => {
                ran = true;
                return Promise.resolve();
              }),
          ),
        LockTimeoutError,
        `Server token '${name}' is being changed by another operation`,
      );
      // Still the retryable lock timeout the CLI exits 75 for.
      assertEquals(error.code, "lock_timeout");
      assertEquals(error.message.includes("server-token-locks"), false);
    } finally {
      await holder.release();
    }
    assertEquals(ran, false);
  });
});

function definitions(
  entries: { id: string; name: string; type: string }[],
): DefinitionRepository {
  const result = (e: { id: string; name: string; type: string }) => ({
    definition: { id: e.id, name: e.name },
    type: { normalized: e.type },
  });
  return {
    findByNameGlobal: (name: string) => {
      const found = entries.find((e) => e.name === name);
      return Promise.resolve(found ? result(found) : null);
    },
    findByIdCached: (id: string) => {
      const found = entries.find((e) => e.id === id);
      return Promise.resolve(found ? result(found) : undefined);
    },
    // The scans an id falls back to when nothing cached has it.
    findById: () => Promise.resolve(null),
    findByIdGlobal: () => Promise.resolve(null),
  } as unknown as DefinitionRepository;
}

Deno.test("serverTokenLockName: a name and its definition's id resolve to the same name", async () => {
  const id = crypto.randomUUID();
  const repo = definitions([
    { id, name: "ci-deploy", type: SERVER_TOKEN_MODEL_TYPE.normalized },
  ]);
  assertEquals(await serverTokenLockName(repo, "ci-deploy"), "ci-deploy");
  assertEquals(await serverTokenLockName(repo, id), "ci-deploy");
});

Deno.test("serverTokenLockName: an identifier that names no server token is returned as given", async () => {
  const otherId = crypto.randomUUID();
  const repo = definitions([
    { id: otherId, name: "a-grant", type: "swamp/grant" },
  ]);
  assertEquals(await serverTokenLockName(repo, "never-minted"), "never-minted");
  assertEquals(await serverTokenLockName(repo, otherId), otherId);
  const unknownId = crypto.randomUUID();
  assertEquals(await serverTokenLockName(repo, unknownId), unknownId);
});
