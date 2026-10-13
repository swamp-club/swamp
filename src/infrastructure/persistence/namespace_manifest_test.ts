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
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  listNamespaceManifests,
  namespaceManifestPath,
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

async function writeRawManifest(
  dir: string,
  namespace: string,
  content: string,
): Promise<void> {
  await Deno.mkdir(join(dir, namespace), { recursive: true });
  await Deno.writeTextFile(namespaceManifestPath(dir, namespace), content);
}

Deno.test("readNamespaceManifest: refuses a manifest that is not valid JSON", async () => {
  await withTempDir(async (dir) => {
    await writeRawManifest(dir, "corrupt-ns", "{INVALID JSON!!!}");

    const error = await assertRejects(
      () => readNamespaceManifest(dir, "corrupt-ns"),
      UserError,
    );
    assertStringIncludes(
      error.message,
      namespaceManifestPath(dir, "corrupt-ns"),
    );
  });
});

Deno.test("readNamespaceManifest: refuses a manifest without string namespace, repoId and registeredAt", async () => {
  await withTempDir(async (dir) => {
    for (
      const content of [
        "{}",
        "[]",
        "null",
        '"infra"',
        '{"namespace":1}',
        '{"namespace":"infra","repoId":"r","registeredAt":123}',
      ]
    ) {
      await writeRawManifest(dir, "bad-shape", content);

      const error = await assertRejects(
        () => readNamespaceManifest(dir, "bad-shape"),
        UserError,
      );
      assertStringIncludes(
        error.message,
        namespaceManifestPath(dir, "bad-shape"),
      );
    }
  });
});

Deno.test("readNamespaceManifest: accepts a manifest without registeredAt", async () => {
  await withTempDir(async (dir) => {
    await writeRawManifest(
      dir,
      "infra",
      '{"namespace":"infra","repoId":"repo-1","extra":true}',
    );

    const manifest = await readNamespaceManifest(dir, "infra");
    assertEquals(manifest?.namespace, "infra");
    assertEquals(manifest?.repoId, "repo-1");
  });
});

Deno.test("listNamespaceManifests: refuses when one manifest is corrupt", async () => {
  await withTempDir(async (dir) => {
    await writeNamespaceManifest(dir, "infra", "repo-1");
    await writeRawManifest(dir, "corrupt-ns", "{INVALID JSON!!!}");

    const error = await assertRejects(
      () => listNamespaceManifests(dir),
      UserError,
    );
    assertStringIncludes(
      error.message,
      namespaceManifestPath(dir, "corrupt-ns"),
    );
  });
});
