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
  type PackageLockValidity,
  readPackageLockValidity,
} from "./package_lock_reader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-package-lock-" });
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

async function writeLock(dir: string, lock: unknown): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "package-lock.json"),
    typeof lock === "string" ? lock : JSON.stringify(lock),
  );
}

function v3Lock(packages: Record<string, unknown>): unknown {
  return {
    name: "ext",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "ext", version: "1.0.0" }, ...packages },
  };
}

function assertInvalid(
  result: PackageLockValidity,
  dir: string,
  reason: string,
): void {
  assertEquals(result.valid, false);
  if (result.valid || result.lockPath === null) {
    throw new Error(`expected an invalid lock, got ${JSON.stringify(result)}`);
  }
  assertPathEquals(result.lockPath, join(dir, "package-lock.json"));
  assertEquals(result.reason, reason);
}

Deno.test("readPackageLockValidity: a v3 lock that matches node_modules is valid", async () => {
  await withTempDir(async (dir) => {
    await writeLock(
      dir,
      v3Lock({
        "node_modules/ms": { version: "2.1.3" },
        "node_modules/@scope/pkg": { version: "1.0.0" },
      }),
    );
    const result = await readPackageLockValidity(dir, [
      { path: "node_modules/ms", version: "2.1.3" },
      { path: "node_modules/@scope/pkg", version: "1.0.0" },
    ]);
    assertEquals(result.valid, true);
    assertPathEquals(result.lockPath ?? "", join(dir, "package-lock.json"));
  });
});

Deno.test("readPackageLockValidity: a v2 lock that matches node_modules is valid", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, {
      lockfileVersion: 2,
      packages: { "node_modules/ms": { version: "2.1.3" } },
      dependencies: { ms: { version: "2.1.3" } },
    });
    const result = await readPackageLockValidity(dir, [
      { path: "node_modules/ms", version: "2.1.3" },
    ]);
    assertEquals(result.valid, true);
  });
});

Deno.test("readPackageLockValidity: two installed copies of one package each match their own lock entry", async () => {
  await withTempDir(async (dir) => {
    await writeLock(
      dir,
      v3Lock({
        "node_modules/ms": { version: "2.1.3" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a/node_modules/ms": { version: "2.0.0" },
      }),
    );
    const result = await readPackageLockValidity(dir, [
      { path: "node_modules/a/node_modules/ms", version: "2.0.0" },
      { path: "node_modules/ms", version: "2.1.3" },
    ]);
    assertEquals(result.valid, true);
  });
});

Deno.test("readPackageLockValidity: an installed version the lock does not say is no lock, with a warning", async () => {
  await withTempDir(async (dir) => {
    await writeLock(
      dir,
      v3Lock({
        "node_modules/ms": { version: "2.1.0" },
        "node_modules/zz": { version: "9.0.0" },
      }),
    );
    // zz also differs; the first in path order is reported.
    const result = await readPackageLockValidity(dir, [
      { path: "node_modules/zz", version: "9.0.1" },
      { path: "node_modules/ms", version: "2.1.3" },
    ]);
    assertInvalid(
      result,
      dir,
      "package-lock.json does not match node_modules: node_modules/ms is " +
        "2.1.3, the lock says 2.1.0; treated as no lock",
    );
  });
});

Deno.test("readPackageLockValidity: a lock version that is not printable is not echoed", async () => {
  await withTempDir(async (dir) => {
    await writeLock(
      dir,
      v3Lock({ "node_modules/ms": { version: "2.1.0\u001b[2J\nok" } }),
    );
    const result = await readPackageLockValidity(dir, [
      { path: "node_modules/ms", version: "2.1.3" },
    ]);
    assertInvalid(
      result,
      dir,
      "package-lock.json does not match node_modules: node_modules/ms is " +
        "2.1.3, the lock says a version that is not printable; treated as " +
        "no lock",
    );
  });
});

Deno.test("readPackageLockValidity: an installed package the lock does not list is no lock, with a warning", async () => {
  await withTempDir(async (dir) => {
    await writeLock(
      dir,
      v3Lock({
        "node_modules/ms": { version: "2.1.3" },
        // Not a package entry: no version string.
        "node_modules/linked": { resolved: "../linked", link: true },
      }),
    );
    for (const path of ["node_modules/debug", "node_modules/linked"]) {
      const result = await readPackageLockValidity(dir, [
        { path: "node_modules/ms", version: "2.1.3" },
        { path, version: "1.0.0" },
      ]);
      assertInvalid(
        result,
        dir,
        `package-lock.json does not match node_modules: the lock has no ` +
          `${path}; treated as no lock`,
      );
    }
  });
});

Deno.test("readPackageLockValidity: an installed path that leaves the package directory never matches", async () => {
  await withTempDir(async (dir) => {
    const paths = [
      "../node_modules/ms",
      "/node_modules/ms",
      "node_modules/../node_modules/ms",
      "node_modules//ms",
      "node_modules\\ms",
    ];
    const packages: Record<string, unknown> = {};
    for (const path of paths) packages[path] = { version: "2.1.3" };
    await writeLock(dir, { lockfileVersion: 3, packages });
    for (const path of paths) {
      const result = await readPackageLockValidity(dir, [
        { path, version: "2.1.3" },
      ]);
      assertEquals(result.valid, false, path);
    }
  });
});

Deno.test("readPackageLockValidity: lockfileVersion 1 or none is no lock, with a warning", async () => {
  await withTempDir(async (dir) => {
    for (
      const lock of [
        { lockfileVersion: 1, dependencies: { ms: { version: "2.1.3" } } },
        { dependencies: { ms: { version: "2.1.3" } } },
      ]
    ) {
      await writeLock(dir, lock);
      const result = await readPackageLockValidity(dir, [
        { path: "node_modules/ms", version: "2.1.3" },
      ]);
      assertInvalid(
        result,
        dir,
        "package-lock.json is lockfileVersion 1, which push cannot match " +
          "against node_modules; treated as no lock. Run npm install with " +
          "npm 7 or later to upgrade it",
      );
    }
  });
});

Deno.test("readPackageLockValidity: no package-lock.json is no lock, with no warning", async () => {
  await withTempDir(async (dir) => {
    const result = await readPackageLockValidity(dir, [
      { path: "node_modules/ms", version: "2.1.3" },
    ]);
    assertEquals(result, { valid: false, lockPath: null });
  });
});

Deno.test("readPackageLockValidity: a package-lock.json that is not JSON is no lock, with a warning", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, "{ not json");
    const result = await readPackageLockValidity(dir, []);
    assertInvalid(
      result,
      dir,
      "package-lock.json could not be read (it is not JSON); treated as no " +
        "lock",
    );
  });
});

Deno.test("readPackageLockValidity: a packages value that is not an object is no lock, with a warning", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, { lockfileVersion: 3, packages: [] });
    const result = await readPackageLockValidity(dir, []);
    assertInvalid(
      result,
      dir,
      "package-lock.json could not be read (it has no packages map); " +
        "treated as no lock",
    );
  });
});

Deno.test("readPackageLockValidity: a v3 lock with no installed packages to match is valid", async () => {
  await withTempDir(async (dir) => {
    await writeLock(dir, v3Lock({}));
    const result = await readPackageLockValidity(dir, []);
    assertEquals(result.valid, true);
  });
});
