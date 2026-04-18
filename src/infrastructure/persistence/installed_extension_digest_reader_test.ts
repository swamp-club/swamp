// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { readInstalledExtensionDigest } from "./installed_extension_digest_reader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_digest_test_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("readInstalledExtensionDigest: returns null when root does not exist", async () => {
  const result = await readInstalledExtensionDigest(
    "/tmp/definitely-does-not-exist-" + crypto.randomUUID(),
  );
  assertEquals(result, null);
});

Deno.test("readInstalledExtensionDigest: identical trees produce identical digests", async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    await Deno.mkdir(join(a, "models"), { recursive: true });
    await Deno.mkdir(join(b, "models"), { recursive: true });
    await Deno.writeTextFile(join(a, "models", "foo.ts"), "content");
    await Deno.writeTextFile(join(b, "models", "foo.ts"), "content");
    await Deno.writeTextFile(join(a, "manifest.yaml"), "name: x");
    await Deno.writeTextFile(join(b, "manifest.yaml"), "name: x");

    const digestA = await readInstalledExtensionDigest(a);
    const digestB = await readInstalledExtensionDigest(b);
    assertEquals(digestA, digestB);
  });
});

Deno.test("readInstalledExtensionDigest: editing a file changes the digest", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await Deno.writeTextFile(join(dir, "models", "foo.ts"), "original");

    const before = await readInstalledExtensionDigest(dir);

    await Deno.writeTextFile(join(dir, "models", "foo.ts"), "edited");

    const after = await readInstalledExtensionDigest(dir);
    assertNotEquals(before, after);
  });
});

Deno.test("readInstalledExtensionDigest: adding a file changes the digest", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await Deno.writeTextFile(join(dir, "models", "foo.ts"), "content");

    const before = await readInstalledExtensionDigest(dir);

    await Deno.writeTextFile(join(dir, "models", "bar.ts"), "new");

    const after = await readInstalledExtensionDigest(dir);
    assertNotEquals(before, after);
  });
});

Deno.test("readInstalledExtensionDigest: removing a file changes the digest", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await Deno.writeTextFile(join(dir, "models", "foo.ts"), "content");
    await Deno.writeTextFile(join(dir, "models", "bar.ts"), "content");

    const before = await readInstalledExtensionDigest(dir);

    await Deno.remove(join(dir, "models", "bar.ts"));

    const after = await readInstalledExtensionDigest(dir);
    assertNotEquals(before, after);
  });
});

Deno.test("readInstalledExtensionDigest: macOS resource forks are ignored", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await Deno.writeTextFile(join(dir, "models", "foo.ts"), "content");

    const before = await readInstalledExtensionDigest(dir);

    // Dropping a Finder-copy resource fork should not perturb the digest.
    await Deno.writeTextFile(join(dir, "models", "._foo.ts"), "fork");
    await Deno.writeTextFile(join(dir, "._manifest.yaml"), "fork");

    const after = await readInstalledExtensionDigest(dir);
    assertEquals(before, after);
  });
});

Deno.test("readInstalledExtensionDigest: empty directory produces a stable digest", async () => {
  await withTempDir(async (dir) => {
    const digest = await readInstalledExtensionDigest(dir);
    // Empty-set digest: SHA-256 of the empty string.
    assertEquals(
      digest,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});
