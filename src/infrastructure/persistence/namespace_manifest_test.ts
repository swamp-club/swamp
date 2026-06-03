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
  listNamespaceManifests,
  readNamespaceManifest,
  writeNamespaceManifest,
} from "./namespace_manifest.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-ns-manifest-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("writeNamespaceManifest: creates manifest file", async () => {
  await withTempDir(async (dir) => {
    await writeNamespaceManifest(dir, "infra", "repo-123");
    const manifest = await readNamespaceManifest(dir, "infra");
    assertNotEquals(manifest, null);
    assertEquals(manifest!.namespace, "infra");
    assertEquals(manifest!.repoId, "repo-123");
    assertNotEquals(manifest!.registeredAt, undefined);
  });
});

Deno.test("readNamespaceManifest: returns null for missing namespace", async () => {
  await withTempDir(async (dir) => {
    const manifest = await readNamespaceManifest(dir, "nonexistent");
    assertEquals(manifest, null);
  });
});

Deno.test("listNamespaceManifests: lists registered namespaces", async () => {
  await withTempDir(async (dir) => {
    await writeNamespaceManifest(dir, "infra", "repo-1");
    await writeNamespaceManifest(dir, "security", "repo-2");

    const manifests = await listNamespaceManifests(dir);
    assertEquals(manifests.length, 2);
    assertEquals(manifests[0].namespace, "infra");
    assertEquals(manifests[1].namespace, "security");
  });
});

Deno.test("listNamespaceManifests: returns empty for nonexistent directory", async () => {
  const manifests = await listNamespaceManifests(
    "/tmp/swamp-ns-test-nonexistent-" + crypto.randomUUID(),
  );
  assertEquals(manifests, []);
});

Deno.test("listNamespaceManifests: skips directories without manifests", async () => {
  await withTempDir(async (dir) => {
    await writeNamespaceManifest(dir, "infra", "repo-1");
    await Deno.mkdir(join(dir, "data"), { recursive: true });

    const manifests = await listNamespaceManifests(dir);
    assertEquals(manifests.length, 1);
    assertEquals(manifests[0].namespace, "infra");
  });
});

Deno.test("listNamespaceManifests: skips dot-prefixed directories", async () => {
  await withTempDir(async (dir) => {
    await writeNamespaceManifest(dir, "infra", "repo-1");
    await Deno.mkdir(join(dir, ".locks"), { recursive: true });

    const manifests = await listNamespaceManifests(dir);
    assertEquals(manifests.length, 1);
  });
});
