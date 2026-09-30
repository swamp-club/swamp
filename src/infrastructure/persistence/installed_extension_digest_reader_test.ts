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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  installedDigestMatches,
  readInstalledExtensionDigest,
} from "./installed_extension_digest_reader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_digest_test_" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
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

// ---- nested entry roots (swamp-club#2723) ----

async function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
}

Deno.test("readInstalledExtensionDigest: a root with no nested entries hashes as before", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, {
      "models/a.ts": "export const a = 1;\n",
      "models/sub/b.ts": "b\n",
      "manifest.yaml": "name: x\n",
    });
    // Pinned from the reader before nested-root exclusion existed.
    const golden =
      "3005ac7db2817ffd05b2e940b0660557d5f047810282ae4599569ecb228dd0e6";
    assertEquals(await readInstalledExtensionDigest(dir), golden);
    assertEquals(
      await readInstalledExtensionDigest(dir, { excludeRelDirs: [] }),
      golden,
    );
  });
});

Deno.test("readInstalledExtensionDigest: leaves out nested entry roots", async () => {
  await withTempDir(async (dir) => {
    const parent = join(dir, "parent");
    const alone = join(dir, "alone");
    const files = { "models/a.ts": "a", "manifest.yaml": "name: parent" };
    await writeTree(parent, files);
    await writeTree(alone, files);
    await writeTree(parent, {
      "child/models/c.ts": "c",
      "deep/er/models/d.ts": "d",
    });

    const withChild = await readInstalledExtensionDigest(parent, {
      excludeRelDirs: ["child", "deep/er"],
    });
    assertEquals(withChild, await readInstalledExtensionDigest(alone));

    await Deno.writeTextFile(join(parent, "child", "models", "c.ts"), "c2");
    assertEquals(
      await readInstalledExtensionDigest(parent, {
        excludeRelDirs: ["child", "deep/er"],
      }),
      withChild,
    );
  });
});

Deno.test("installedDigestMatches: accepts the legacy whole-tree digest only for roots with nested entries", async () => {
  await withTempDir(async (dir) => {
    await writeTree(dir, {
      "models/a.ts": "a",
      "child/models/c.ts": "c",
    });
    const legacy = await readInstalledExtensionDigest(dir);
    const current = await readInstalledExtensionDigest(dir, {
      excludeRelDirs: ["child"],
    });
    assertNotEquals(legacy, current);

    assertEquals(await installedDigestMatches(dir, current!, ["child"]), true);
    assertEquals(await installedDigestMatches(dir, legacy!, ["child"]), true);
    // With no nested entries there is nothing legacy to accept.
    assertEquals(await installedDigestMatches(dir, current!, []), false);
    assertEquals(await installedDigestMatches(dir, "other", ["child"]), false);

    await Deno.writeTextFile(join(dir, "models", "a.ts"), "edited");
    assertEquals(await installedDigestMatches(dir, legacy!, ["child"]), false);
    assertEquals(await installedDigestMatches(dir, current!, ["child"]), false);
  });
});

Deno.test("installedDigestMatches: returns null when the root is missing", async () => {
  assertEquals(
    await installedDigestMatches(
      "/tmp/definitely-does-not-exist-" + crypto.randomUUID(),
      "x",
      [],
    ),
    null,
  );
});
