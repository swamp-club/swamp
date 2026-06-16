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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import type { ExtensionManifest } from "./extension_manifest.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  computePackageCacheHash,
  defaultPackageCacheRoot,
  ExtensionPackageCache,
  type PackageCacheHashInput,
} from "./extension_package_cache.ts";

function makeManifest(
  overrides: Partial<ExtensionManifest> = {},
): ExtensionManifest {
  return {
    manifestVersion: 1,
    name: "@example/test",
    version: "2026.01.01.0",
    description: "A test extension",
    repository: "https://github.com/example/test",
    paths: { base: "typedDir" },
    workflows: [],
    models: ["my-model.ts"],
    vaults: [],
    drivers: [],
    datastores: [],
    reports: [],
    skills: [],
    include: [],
    additionalFiles: ["README.md"],
    binaries: [],
    platforms: ["linux", "darwin"],
    labels: [],
    releaseNotes: undefined,
    dependencies: [],
    ...overrides,
  };
}

async function makeHashInput(
  tmp: string,
  overrides: Partial<PackageCacheHashInput> = {},
): Promise<PackageCacheHashInput> {
  const model = join(tmp, "model.ts");
  await Deno.writeTextFile(model, "export function hi() {}\n");
  return {
    manifest: makeManifest(),
    rootDir: tmp,
    modelFilePaths: [model],
    vaultFilePaths: [],
    driverFilePaths: [],
    datastoreFilePaths: [],
    reportFilePaths: [],
    workflowFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    skillFilePaths: [],
    includeFilePaths: [],
    denoConfigPath: undefined,
    packageJsonPath: undefined,
    ...overrides,
  };
}

Deno.test("computePackageCacheHash: identical inputs produce identical hashes", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const input = await makeHashInput(tmp);
    const h1 = await computePackageCacheHash(input);
    const h2 = await computePackageCacheHash(input);
    assertEquals(h1, h2);
    assertEquals(h1.length, 64); // SHA-256 hex
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("computePackageCacheHash: manifest name change invalidates hash", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const base = await makeHashInput(tmp);
    const changed = {
      ...base,
      manifest: makeManifest({ name: "@example/other" }),
    };
    const h1 = await computePackageCacheHash(base);
    const h2 = await computePackageCacheHash(changed);
    assertNotEquals(h1, h2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("computePackageCacheHash: file content change invalidates hash", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const input = await makeHashInput(tmp);
    const h1 = await computePackageCacheHash(input);
    await Deno.writeTextFile(
      input.modelFilePaths[0],
      "export function hi() { return 1; }\n",
    );
    const h2 = await computePackageCacheHash(input);
    assertNotEquals(h1, h2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("computePackageCacheHash: deno config change invalidates hash", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const denoConfigPath = join(tmp, "deno.json");
    await Deno.writeTextFile(denoConfigPath, `{"compilerOptions":{}}`);
    const base = await makeHashInput(tmp, { denoConfigPath });
    const h1 = await computePackageCacheHash(base);
    await Deno.writeTextFile(
      denoConfigPath,
      `{"compilerOptions":{"strict":true}}`,
    );
    const h2 = await computePackageCacheHash(base);
    assertNotEquals(h1, h2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("computePackageCacheHash: missing file still hashes deterministically", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const input = await makeHashInput(tmp, {
      modelFilePaths: [join(tmp, "does-not-exist.ts")],
    });
    const h1 = await computePackageCacheHash(input);
    const h2 = await computePackageCacheHash(input);
    assertEquals(h1, h2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("computePackageCacheHash: file order does not affect hash", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const a = join(tmp, "a.ts");
    const b = join(tmp, "b.ts");
    await Deno.writeTextFile(a, "a");
    await Deno.writeTextFile(b, "b");
    const input1 = await makeHashInput(tmp, { modelFilePaths: [a, b] });
    const input2 = { ...input1, modelFilePaths: [b, a] };
    const h1 = await computePackageCacheHash(input1);
    const h2 = await computePackageCacheHash(input2);
    assertEquals(h1, h2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("computePackageCacheHash: same files under different roots produce identical hashes", async () => {
  const tmp1 = await Deno.makeTempDir();
  const tmp2 = await Deno.makeTempDir();
  try {
    const content = "export function hi() {}\n";
    await Deno.writeTextFile(join(tmp1, "model.ts"), content);
    await Deno.writeTextFile(join(tmp2, "model.ts"), content);
    const input1 = await makeHashInput(tmp1);
    const input2 = await makeHashInput(tmp2);
    const h1 = await computePackageCacheHash(input1);
    const h2 = await computePackageCacheHash(input2);
    assertEquals(h1, h2);
  } finally {
    await Deno.remove(tmp1, { recursive: true });
    await Deno.remove(tmp2, { recursive: true });
  }
});

Deno.test("ExtensionPackageCache: get returns null when entry absent", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const cache = new ExtensionPackageCache(join(tmp, "packages"));
    const got = await cache.get("deadbeef");
    assertEquals(got, null);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ExtensionPackageCache: put writes and get retrieves", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const cache = new ExtensionPackageCache(join(tmp, "packages"));
    const bytes = new Uint8Array([0x1f, 0x8b, 0x01, 0x02, 0x03]);
    await cache.put("abcd1234", bytes, {
      extensionName: "@example/test",
      extensionVersion: "2026.01.01.0",
      rubricVersion: 1,
    });

    const got = await cache.get("abcd1234");
    assert(got !== null);
    assertEquals(got.archiveBytes, bytes);
    assertEquals(got.metadata.extensionName, "@example/test");
    assertEquals(got.metadata.extensionVersion, "2026.01.01.0");
    assertEquals(got.metadata.rubricVersion, 1);
    assertEquals(got.metadata.archiveSize, bytes.length);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ExtensionPackageCache: get returns null for corrupt metadata", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const cache = new ExtensionPackageCache(join(tmp, "packages"));
    const entry = cache.entryDir("abc");
    await Deno.mkdir(entry, { recursive: true });
    await Deno.writeFile(join(entry, "extension.tar.gz"), new Uint8Array([1]));
    await Deno.writeTextFile(join(entry, "metadata.json"), "not json");

    const got = await cache.get("abc");
    assertEquals(got, null);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("defaultPackageCacheRoot: returns canonical path under .swamp", () => {
  const root = defaultPackageCacheRoot("/tmp/repo");
  assertPathEquals(root, "/tmp/repo/.swamp/cache/packages");
});
