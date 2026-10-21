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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { assertPathEquals } from "../persistence/path_test_helpers.ts";
import {
  lockfilePathFor,
  MAX_LOCKFILE_BYTES,
  readDenoLockfile,
  readOnlyLockFor,
  readProjectLockfile,
} from "./deno_lockfile_reader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-deno-lockfile-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't released a handle yet.
      // Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const V5_LOCK = {
  version: "5",
  specifiers: {
    "npm:ms@2": "2.0.0",
    "npm:@scope/pkg@^1.1.0": "1.1.4_react@18.2.0",
    "jsr:@std/path@1": "1.1.4",
  },
  jsr: { "@std/path@1.1.4": { integrity: "x" }, "@std/internal@1.0.12": {} },
  npm: {
    "ms@2.0.0": { integrity: "x" },
    "ms@2.1.3": { integrity: "x" },
    "@scope/pkg@1.1.4_react@18.2.0": { integrity: "x" },
  },
  workspace: { dependencies: ["npm:ms@2"] },
};

async function writeLock(dir: string, body: unknown, name = "deno.lock") {
  const path = join(dir, name);
  await Deno.writeTextFile(path, JSON.stringify(body));
  return path;
}

Deno.test("readDenoLockfile: reads specifier values and section keys of a v5 lock", async () => {
  await withTempDir(async (dir) => {
    const lock = await readDenoLockfile(await writeLock(dir, V5_LOCK));
    assertEquals(lock?.source, "deno.lock");
    assertEquals(lock?.versionsFor("npm", "ms").toSorted(), ["2.0.0", "2.1.3"]);
    assertEquals(lock?.versionsFor("npm", "@scope/pkg"), ["1.1.4"]);
    assertEquals(lock?.versionsFor("jsr", "@std/path"), ["1.1.4"]);
    assertEquals(lock?.versionsFor("jsr", "@std/internal"), ["1.0.12"]);
    assertEquals(lock?.versionsFor("npm", "@std/path"), []);
  });
});

Deno.test("readDenoLockfile: resolves an import through its own specifier entry, matching equivalent ranges", async () => {
  await withTempDir(async (dir) => {
    const lock = await readDenoLockfile(await writeLock(dir, V5_LOCK));
    // `npm:ms@2` is how Deno writes `^2.0.0`; ms@2.1.3 is a transitive copy.
    assertEquals(lock?.resolvedFor("npm", "ms", "^2.0.0"), "2.0.0");
    assertEquals(lock?.resolvedFor("npm", "ms", "2"), "2.0.0");
    assertEquals(lock?.resolvedFor("npm", "ms", "^2.1.0"), undefined);
    assertEquals(lock?.resolvedFor("npm", "@scope/pkg", "^1.1.0"), "1.1.4");
    assertEquals(lock?.resolvedFor("jsr", "@std/path", "^1.0.0"), "1.1.4");
    assertEquals(lock?.resolvedFor("npm", "ms", null), undefined);
  });
});

Deno.test("readDenoLockfile: reads a v4 lock the same way", async () => {
  await withTempDir(async (dir) => {
    const lock = await readDenoLockfile(
      await writeLock(dir, { ...V5_LOCK, version: "4" }),
    );
    assertEquals(lock?.versionsFor("jsr", "@std/path"), ["1.1.4"]);
  });
});

Deno.test("readDenoLockfile: another format, bad JSON or no file is no lock", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await readDenoLockfile(
        await writeLock(dir, { ...V5_LOCK, version: "3" }),
      ),
      undefined,
    );
    const bad = join(dir, "bad.lock");
    await Deno.writeTextFile(bad, "{not json");
    assertEquals(await readDenoLockfile(bad), undefined);
    assertEquals(await readDenoLockfile(join(dir, "missing.lock")), undefined);
  });
});

Deno.test("readDenoLockfile: a lock over the size cap is not read", async () => {
  await withTempDir(async (dir) => {
    const path = await writeLock(dir, V5_LOCK);
    await Deno.truncate(path, MAX_LOCKFILE_BYTES + 1);
    assertEquals(await readDenoLockfile(path), undefined);
  });
});

Deno.test("lockfilePathFor: a deno.json without a lock setting uses the deno.lock beside it", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, JSON.stringify({ imports: {} }));
    assertPathEquals(
      await lockfilePathFor({ denoConfigPath: config }),
      join(dir, "deno.lock"),
    );
  });
});

Deno.test("lockfilePathFor: honours the lock setting of a config with comments, as a deno.jsonc (swamp-club#3612)", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.jsonc");
    await Deno.writeTextFile(config, '{ // comment\n "lock": false, }');
    assertEquals(await lockfilePathFor({ denoConfigPath: config }), undefined);

    await Deno.writeTextFile(config, '// comment\n{ "lock": "locks/a.lock" }');
    assertPathEquals(
      await lockfilePathFor({ denoConfigPath: config }),
      join(dir, "locks", "a.lock"),
    );

    await Deno.writeTextFile(config, "/* no lock setting */ {}");
    assertPathEquals(
      await lockfilePathFor({ denoConfigPath: config }),
      join(dir, "deno.lock"),
    );
  });
});

Deno.test("lockfilePathFor: a config that cannot be parsed reads no lock", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, '{ "lock": false');
    assertEquals(await lockfilePathFor({ denoConfigPath: config }), undefined);
  });
});

Deno.test("lockfilePathFor: honours the deno.json lock setting", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, JSON.stringify({ lock: false }));
    assertEquals(await lockfilePathFor({ denoConfigPath: config }), undefined);

    await Deno.writeTextFile(config, JSON.stringify({ lock: "locks/a.lock" }));
    assertPathEquals(
      await lockfilePathFor({ denoConfigPath: config }),
      join(dir, "locks", "a.lock"),
    );

    await Deno.writeTextFile(
      config,
      JSON.stringify({ lock: { path: "b.lock", frozen: true } }),
    );
    assertPathEquals(
      await lockfilePathFor({ denoConfigPath: config }),
      join(dir, "b.lock"),
    );
  });
});

Deno.test("lockfilePathFor: package.json mode uses the deno.lock in its directory", async () => {
  assertPathEquals(
    await lockfilePathFor({ packageJsonDir: join("a", "b") }),
    join("a", "b", "deno.lock"),
  );
});

Deno.test("lockfilePathFor: no project means no lock, as the bundler runs with --no-lock", async () => {
  assertEquals(await lockfilePathFor({}), undefined);
});

Deno.test("readProjectLockfile: a lock beside a missing deno.json is ignored", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, V5_LOCK);
    assertEquals(await readProjectLockfile({}), undefined);
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, "{}");
    const lock = await readProjectLockfile({ denoConfigPath: config });
    assertEquals(lock?.versionsFor("npm", "ms").toSorted(), ["2.0.0", "2.1.3"]);
  });
});

Deno.test("readProjectLockfile: a custom lock path names that file in findings", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, V5_LOCK, "custom.lock");
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, JSON.stringify({ lock: "custom.lock" }));
    const lock = await readProjectLockfile({ denoConfigPath: config });
    assertEquals(lock?.source, "custom.lock");
  });
});

Deno.test("readOnlyLockFor: a deno.json project freezes the deno.lock beside it, or has none", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, "{}");
    assertEquals(await readOnlyLockFor({ denoConfigPath: config }), {});
    const lock = await writeLock(dir, V5_LOCK);
    assertPathEquals(
      (await readOnlyLockFor({ denoConfigPath: config })).lockPath,
      lock,
    );
  });
});

Deno.test("readOnlyLockFor: follows the deno.json lock setting", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, V5_LOCK);
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, JSON.stringify({ lock: false }));
    assertEquals(await readOnlyLockFor({ denoConfigPath: config }), {});

    await Deno.writeTextFile(config, JSON.stringify({ lock: "custom.lock" }));
    assertEquals(await readOnlyLockFor({ denoConfigPath: config }), {});
    const custom = await writeLock(dir, V5_LOCK, "custom.lock");
    assertPathEquals(
      (await readOnlyLockFor({ denoConfigPath: config })).lockPath,
      custom,
    );
  });
});

Deno.test("readOnlyLockFor: a deno.json that cannot be parsed keeps the deno.lock beside it", async () => {
  await withTempDir(async (dir) => {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(config, '{ "imports": {}');
    assertEquals(await readOnlyLockFor({ denoConfigPath: config }), {});
    const lock = await writeLock(dir, V5_LOCK);
    assertPathEquals(
      (await readOnlyLockFor({ denoConfigPath: config })).lockPath,
      lock,
    );
  });
});

Deno.test("readOnlyLockFor: package.json mode freezes the deno.lock in its directory, or has none", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readOnlyLockFor({ packageJsonDir: dir }), {});
    const lock = await writeLock(dir, V5_LOCK);
    assertPathEquals(
      (await readOnlyLockFor({ packageJsonDir: dir })).lockPath,
      lock,
    );
  });
});

Deno.test("readOnlyLockFor: a directory named like the lock is no lock", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "deno.lock"));
    assertEquals(await readOnlyLockFor({ packageJsonDir: dir }), {});
  });
});
