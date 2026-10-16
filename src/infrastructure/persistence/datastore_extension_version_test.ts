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
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import {
  V3_BUCKET_MIN_EXTENSION_VERSION,
  V3_EXTENSION_TOO_OLD_CODE,
  V3BucketExtensionTooOldError,
} from "../../domain/datastore/v3_hosting.ts";
import { UserError } from "../../domain/errors.ts";
import {
  assertV3BucketExtensionVersion,
  assertV3BucketExtensionVersions,
  loadedDatastoreExtension,
  pulledExtensionOf,
} from "./datastore_extension_version.ts";
import { swampPath } from "./paths.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-ds-ext-version-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Writes a pulled extension and returns its datastore source path. */
async function pullExtension(
  root: string,
  name: string,
  manifest: string | null,
): Promise<string> {
  const extDir = join(root, ...name.split("/"));
  const datastores = join(extDir, "datastores", "s3");
  await Deno.mkdir(datastores, { recursive: true });
  if (manifest !== null) {
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), manifest);
  }
  const source = join(datastores, "mod.ts");
  await Deno.writeTextFile(source, "export const datastore = {};\n");
  return source;
}

for (
  const [label, rootOf] of [
    [
      "pulled-extensions",
      (repo: string) => swampPath(repo, "pulled-extensions"),
    ],
    [
      "config/pulled-extensions",
      (repo: string) => swampPath(repo, "config", "pulled-extensions"),
    ],
  ] as const
) {
  Deno.test(`pulledExtensionOf: reads a scoped extension's manifest under ${label}`, async () => {
    await withTempDir(async (repo) => {
      const source = await pullExtension(
        rootOf(repo),
        "@swamp/s3-datastore",
        'name: "@swamp/s3-datastore"\nversion: "2026.10.16.3"\n',
      );
      assertEquals(pulledExtensionOf(repo, source), {
        name: "@swamp/s3-datastore",
        version: "2026.10.16.3",
      });
    });
  });
}

Deno.test("pulledExtensionOf: reads a deeper extension name", async () => {
  await withTempDir(async (repo) => {
    const source = await pullExtension(
      swampPath(repo, "pulled-extensions"),
      "@acme/stores/s3",
      'name: "@acme/stores/s3"\nversion: "2026.10.17.1"\n',
    );
    assertEquals(pulledExtensionOf(repo, source)?.version, "2026.10.17.1");
  });
});

Deno.test("pulledExtensionOf: an extension with no manifest is unknown", async () => {
  await withTempDir(async (repo) => {
    const source = await pullExtension(
      swampPath(repo, "pulled-extensions"),
      "@swamp/s3-datastore",
      null,
    );
    assertEquals(pulledExtensionOf(repo, source), undefined);
  });
});

Deno.test("pulledExtensionOf: a manifest naming another extension is unknown", async () => {
  await withTempDir(async (repo) => {
    const source = await pullExtension(
      swampPath(repo, "pulled-extensions"),
      "@swamp/s3-datastore",
      'name: "@other/thing"\nversion: "2027.01.01.1"\n',
    );
    assertEquals(pulledExtensionOf(repo, source), undefined);
  });
});

Deno.test("pulledExtensionOf: never reads a manifest at or above a pulled root", async () => {
  await withTempDir(async (repo) => {
    const root = swampPath(repo, "pulled-extensions");
    const source = await pullExtension(root, "@swamp/s3-datastore", null);
    await Deno.writeTextFile(
      join(root, "manifest.yaml"),
      'name: "@swamp/s3-datastore"\nversion: "2027.01.01.1"\n',
    );
    await Deno.writeTextFile(
      join(repo, "manifest.yaml"),
      'name: "@swamp/s3-datastore"\nversion: "2027.01.01.1"\n',
    );
    assertEquals(pulledExtensionOf(repo, source), undefined);
  });
});

Deno.test("pulledExtensionOf: a source outside the pulled roots is unknown", async () => {
  await withTempDir(async (repo) => {
    const source = await pullExtension(
      join(repo, "extensions"),
      "@swamp/s3-datastore",
      'name: "@swamp/s3-datastore"\nversion: "2026.10.16.3"\n',
    );
    assertEquals(pulledExtensionOf(repo, source), undefined);
  });
});

Deno.test("loadedDatastoreExtension: follows the registered type's source path", async () => {
  await withTempDir(async (repo) => {
    const source = await pullExtension(
      swampPath(repo, "pulled-extensions"),
      "@swamp/s3-datastore",
      'name: "@swamp/s3-datastore"\nversion: "2026.10.16.5"\n',
    );
    const type = `@test/ext-version-${crypto.randomUUID().slice(0, 8)}`;
    try {
      datastoreTypeRegistry.register({
        type,
        name: "Fake",
        description: "Fake",
        isBuiltIn: false,
        sourcePath: source,
      });
      assertEquals(
        loadedDatastoreExtension(repo, type)?.version,
        "2026.10.16.5",
      );
    } finally {
      datastoreTypeRegistry.invalidateType(type);
    }
    assertEquals(loadedDatastoreExtension(repo, type), undefined);
  });
});

const S3 = "@swamp/s3-datastore";

async function writeLockfile(
  dir: string,
  entries: Record<string, string>,
): Promise<string> {
  const path = join(dir, "upstream_extensions.json");
  await Deno.writeTextFile(
    path,
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entries).map(([name, version]) => [name, {
          version,
          pulledAt: "2026-10-16T00:00:00.000Z",
          files: [],
        }]),
      ),
    ),
  );
  return path;
}

Deno.test("assertV3BucketExtensionVersions: refuses a loaded extension below the minimum", async () => {
  const error = await assertRejects(
    () =>
      assertV3BucketExtensionVersions(
        "/repo",
        S3,
        undefined,
        () => ({ name: S3, version: "2026.10.16.4" }),
      ),
    V3BucketExtensionTooOldError,
  );
  assertStringIncludes(error.message, "its extension is 2026.10.16.4");
});

Deno.test("assertV3BucketExtensionVersions: refuses a current extension the committed lockfile pins below the minimum", async () => {
  await withTempDir(async (dir) => {
    const lockfile = await writeLockfile(dir, { [S3]: "2026.10.16.2" });
    const error = await assertRejects(
      () =>
        assertV3BucketExtensionVersions(
          dir,
          S3,
          lockfile,
          () => ({ name: S3, version: "2026.10.16.5" }),
        ),
      V3BucketExtensionTooOldError,
    );
    assertStringIncludes(
      error.message,
      "the repo's lockfile pins its extension at 2026.10.16.2",
    );
  });
});

Deno.test("assertV3BucketExtensionVersions: looks the pin up by extension name, not datastore type", async () => {
  await withTempDir(async (dir) => {
    const lockfile = await writeLockfile(dir, {
      "@acme/stores": "2026.10.16.1",
      "@acme/s3": "2026.10.16.9",
    });
    await assertRejects(
      () =>
        assertV3BucketExtensionVersions(
          dir,
          "@acme/s3",
          lockfile,
          () => ({ name: "@acme/stores", version: "2026.10.16.6" }),
        ),
      V3BucketExtensionTooOldError,
    );
  });
});

Deno.test("assertV3BucketExtensionVersions: passes current versions, a missing pin, a missing lockfile, managedConfig and an unknown extension", async () => {
  await withTempDir(async (dir) => {
    const current = () => ({ name: S3, version: "2026.10.16.5" });
    await assertV3BucketExtensionVersions(
      dir,
      S3,
      await writeLockfile(dir, { [S3]: "2026.10.17.1" }),
      current,
    );
    await assertV3BucketExtensionVersions(
      dir,
      S3,
      await writeLockfile(dir, { "@other/ext": "2026.01.01.1" }),
      current,
    );
    await assertV3BucketExtensionVersions(
      dir,
      S3,
      join(dir, "missing", "upstream_extensions.json"),
      current,
    );
    await assertV3BucketExtensionVersions(dir, S3, undefined, current);
    await assertV3BucketExtensionVersions(
      dir,
      S3,
      await writeLockfile(dir, { [S3]: "2026.10.16.1" }),
      () => undefined,
    );
  });
});

Deno.test("assertV3BucketExtensionVersion: refuses a release below the minimum, naming the update", () => {
  for (const version of ["2026.10.16.4", "2026.10.16.1", "2026.09.30.12"]) {
    const err = assertThrows(
      () => assertV3BucketExtensionVersion(version, "@swamp/s3-datastore"),
      V3BucketExtensionTooOldError,
    );
    assertInstanceOf(err, UserError);
    assertEquals(err.code, V3_EXTENSION_TOO_OLD_CODE);
    assertEquals(err.version, version);
    assertStringIncludes(err.message, `its extension is ${version}`);
    assertStringIncludes(err.message, V3_BUCKET_MIN_EXTENSION_VERSION);
    assertStringIncludes(
      err.message,
      "swamp extension update @swamp/s3-datastore",
    );
  }
});

Deno.test("assertV3BucketExtensionVersion: the micro counter compares as a number", () => {
  assertThrows(
    () => assertV3BucketExtensionVersion("2026.10.16.4", "t"),
    V3BucketExtensionTooOldError,
  );
  assertV3BucketExtensionVersion("2026.10.16.10", "t");
});

Deno.test("assertV3BucketExtensionVersion: accepts the minimum and later releases", () => {
  for (
    const version of [
      V3_BUCKET_MIN_EXTENSION_VERSION,
      "2026.10.16.6",
      "2026.10.17.1",
      "2027.01.01.1",
    ]
  ) {
    assertV3BucketExtensionVersion(version, "@swamp/s3-datastore");
  }
});

Deno.test("assertV3BucketExtensionVersion: an unknown or unpublished version passes", () => {
  for (const version of [undefined, "", "0.0.0", "1.2.3", "latest"]) {
    assertV3BucketExtensionVersion(version, "@swamp/s3-datastore");
  }
});

Deno.test("assertV3BucketExtensionVersion: names where the version came from", () => {
  const err = assertThrows(
    () =>
      assertV3BucketExtensionVersion(
        "2026.10.16.2",
        "@swamp/gcs-datastore",
        "the repo's lockfile pins its extension at",
      ),
    V3BucketExtensionTooOldError,
  );
  assertStringIncludes(
    err.message,
    "the repo's lockfile pins its extension at 2026.10.16.2",
  );
});
