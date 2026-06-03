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

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { LockfileRepository } from "./lockfile_repository.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { UserError } from "../../domain/errors.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lockfile-repo-test-" });
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

Deno.test("LockfileRepository.create: missing lockfile yields empty cache", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);

    assertEquals(repo.getAllEntries(), {});
    assertEquals(repo.getEntry("@scope/missing"), null);
    assertEquals(repo.getLockedVersion("@scope/missing"), null);
  });
});

Deno.test("LockfileRepository.create: existing lockfile populates cache", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const initial = {
      "@scope/foo": {
        version: "2026.01.01.1",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: ["models/foo.ts"],
      },
    };
    await atomicWriteTextFile(path, JSON.stringify(initial, null, 2));

    const repo = await LockfileRepository.create(path);

    assertEquals(repo.getEntry("@scope/foo")?.version, "2026.01.01.1");
    assertEquals(repo.getLockedVersion("@scope/foo"), "2026.01.01.1");
    assertEquals(Object.keys(repo.getAllEntries()), ["@scope/foo"]);
  });
});

Deno.test("LockfileRepository: cross-instance snapshot regression — repoA caches old, repoB sees new", async () => {
  // Load-bearing test for ADV-1 (W2 prequel snapshot semantics). Mutates
  // disk via a SIBLING LockfileRepository, NOT repoA.writeEntry, so the
  // test exercises CROSS-INSTANCE staleness (the W1b race-window contract)
  // rather than within-instance coherence (which writeEntry guarantees).
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const initial = {
      "@scope/foo": {
        version: "2026.01.01.1",
        pulledAt: "2026-01-01T00:00:00.000Z",
      },
    };
    await atomicWriteTextFile(path, JSON.stringify(initial, null, 2));

    const repoA = await LockfileRepository.create(path);
    assertEquals(repoA.getLockedVersion("@scope/foo"), "2026.01.01.1");

    // Out-of-band write via a SIBLING instance. repoA's cache is now stale.
    const sibling = await LockfileRepository.create(path);
    await sibling.writeEntry("@scope/foo", "2026.05.05.1", []);

    // repoA still serves the OLD value from its construction-time cache.
    assertEquals(repoA.getLockedVersion("@scope/foo"), "2026.01.01.1");

    // A freshly-constructed repoB sees the NEW value.
    const repoB = await LockfileRepository.create(path);
    assertEquals(repoB.getLockedVersion("@scope/foo"), "2026.05.05.1");
  });
});

Deno.test("LockfileRepository.writeEntry: creates file and updates own cache", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "nested", "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);

    await repo.writeEntry("@scope/foo", "2026.05.05.1", ["models/foo.ts"], {
      checksum: "abc123",
    });

    // Cache reflects the write immediately.
    assertEquals(repo.getEntry("@scope/foo")?.version, "2026.05.05.1");
    assertEquals(repo.getEntry("@scope/foo")?.checksum, "abc123");

    // Disk reflects the write.
    const onDisk = JSON.parse(await Deno.readTextFile(path));
    assertEquals(onDisk["@scope/foo"].version, "2026.05.05.1");
    assertEquals(onDisk["@scope/foo"].files, ["models/foo.ts"]);
  });
});

Deno.test("LockfileRepository.writeEntry: omits empty/undefined optional fields", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);

    await repo.writeEntry("@scope/foo", "2026.05.05.1", []);

    const entry = repo.getEntry("@scope/foo")!;
    assertEquals(entry.version, "2026.05.05.1");
    assertEquals(entry.files, []);
    assertEquals(entry.checksum, undefined);
    assertEquals(entry.serverUrl, undefined);
    assertEquals(entry.include, undefined);
  });
});

Deno.test("LockfileRepository.writeEntry: re-reads disk under lock to avoid clobbering siblings", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");

    // Construct repoA with empty cache.
    const repoA = await LockfileRepository.create(path);

    // Sibling writes entry B to disk while repoA's cache is still empty.
    const sibling = await LockfileRepository.create(path);
    await sibling.writeEntry("@scope/sibling", "1.0.0", []);

    // repoA writes entry A. The re-read-under-lock step picks up the
    // sibling's entry B; both survive.
    await repoA.writeEntry("@scope/a", "2.0.0", []);

    const onDisk = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(onDisk).sort(), ["@scope/a", "@scope/sibling"]);
  });
});

Deno.test("LockfileRepository.removeEntry: deletes key and persists", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);
    await repo.writeEntry("@scope/foo", "1.0.0", []);
    await repo.writeEntry("@scope/bar", "2.0.0", []);

    await repo.removeEntry("@scope/foo");

    assertEquals(repo.getEntry("@scope/foo"), null);
    assertEquals(repo.getEntry("@scope/bar")?.version, "2.0.0");

    const onDisk = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(onDisk), ["@scope/bar"]);
  });
});

Deno.test("LockfileRepository.removeEntry: creates parent dir (symmetric with writeEntry)", async () => {
  await withTempDir(async (dir) => {
    // Construct against a path whose parent dir does NOT exist yet.
    // removeEntry must create it before acquireLock — otherwise
    // Deno.open hits NotFound and propagates an unhelpful error.
    const path = join(dir, "nested", "subdir", "upstream_extensions.json");
    const repo = new LockfileRepository(path, {});

    // Should not throw.
    await repo.removeEntry("@scope/never-existed");

    // The empty lockfile is now persisted and the parent dir exists.
    const onDisk = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(onDisk).length, 0);
  });
});

Deno.test("LockfileRepository.removeEntry: missing key is a no-op", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);
    await repo.writeEntry("@scope/keep", "1.0.0", []);

    // Should not throw.
    await repo.removeEntry("@scope/never-existed");

    assertEquals(repo.getEntry("@scope/keep")?.version, "1.0.0");
  });
});

Deno.test("LockfileRepository: getAllEntries returns a defensive deep copy", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);
    await repo.writeEntry("@scope/foo", "1.0.0", ["models/foo.ts"], {
      include: ["dep.ts"],
    });

    const map = repo.getAllEntries();

    // Top-level key deletion must not affect the cache.
    delete map["@scope/foo"];
    assertNotEquals(repo.getEntry("@scope/foo"), null);

    // Nested array mutation must not affect the cache either —
    // deep copy guards against `entries["@x/y"].files!.push(...)`
    // patterns that a shallow copy would propagate.
    const fresh = repo.getAllEntries();
    fresh["@scope/foo"].files!.push("INJECTED");
    fresh["@scope/foo"].include!.push("INJECTED");
    assertEquals(repo.getEntry("@scope/foo")?.files, ["models/foo.ts"]);
    assertEquals(repo.getEntry("@scope/foo")?.include, ["dep.ts"]);
  });
});

Deno.test("LockfileRepository: concurrent writers all complete via acquireLock retry", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const N = 5;

    // Each writer constructs its own repo (mirrors how lifecycle services
    // would behave under concurrency) and writes a unique entry.
    const writers = Array.from({ length: N }, (_, i) =>
      (async () => {
        const repo = await LockfileRepository.create(path);
        await repo.writeEntry(`@scope/ext${i}`, `${i}.0.0`, []);
      })());

    await Promise.all(writers);

    // Final on-disk state has all N entries — count assertion, not
    // elapsed-time assertion (CI-flake-prone).
    const onDisk = JSON.parse(await Deno.readTextFile(path));
    assertEquals(Object.keys(onDisk).length, N);
    for (let i = 0; i < N; i++) {
      assertEquals(onDisk[`@scope/ext${i}`].version, `${i}.0.0`);
    }
  });
});

Deno.test("LockfileRepository: lock-acquisition exhaustion throws UserError (clean CLI message, not stack trace)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const lockPath = `${path}.lock`;

    // Pre-create the lock file so every retry sees AlreadyExists.
    // 10 retries × 100ms = ~1s before the writer gives up.
    await Deno.writeTextFile(lockPath, "");

    const repo = await LockfileRepository.create(path);
    const error = await assertRejects(
      () => repo.writeEntry("@scope/foo", "1.0.0", []),
      UserError,
      "Could not acquire lock on upstream_extensions.json",
    );
    // Top-level error_output renderer keys off `instanceof UserError` to
    // emit a clean message rather than a stack trace; this assertion
    // pins the contract.
    assertEquals(error instanceof UserError, true);

    await Deno.remove(lockPath);
  });
});

Deno.test("LockfileRepository: cleans up .lock file on success path", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(path);

    await repo.writeEntry("@scope/foo", "1.0.0", []);

    // .lock file should not exist after success.
    let lockExists = true;
    try {
      await Deno.stat(`${path}.lock`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) lockExists = false;
      else throw error;
    }
    assertEquals(lockExists, false);
  });
});

Deno.test("LockfileRepository: in-memory constructor takes explicit cache (test seam)", () => {
  const repo = new LockfileRepository("/test/repo/upstream_extensions.json", {
    "@scope/preset": {
      version: "9.9.9",
      pulledAt: "2026-01-01T00:00:00.000Z",
    },
  });

  assertEquals(repo.getLockedVersion("@scope/preset"), "9.9.9");
  assertEquals(repo.getEntry("@scope/preset")?.version, "9.9.9");
});
