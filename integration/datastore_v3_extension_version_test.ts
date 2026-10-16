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

// The minimum S3/GCS extension version for v3 bucket datastores
// (swamp-club#3567), wired end to end: a pulled datastore extension loaded
// through the real extension loader records where it came from, the format
// guard reads that extension's manifest version when a format-3 config
// opens, and setup's dependency also checks the committed lockfile pin.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { CustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import {
  V3_BUCKET_MIN_EXTENSION_VERSION,
  V3BucketExtensionTooOldError,
} from "../src/domain/datastore/v3_hosting.ts";
import { datastoreKindAdapter } from "../src/domain/extensions/datastore_kind_adapter.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { ensureSupportedDatastoreFormat } from "../src/infrastructure/persistence/datastore_format_guard.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { createDatastoreSetupDeps } from "../src/libswamp/datastores/setup.ts";

class StubDenoRuntime implements DenoRuntime {
  ensureDeno(): Promise<string> {
    return Promise.resolve("deno");
  }
  getDenoEnv(): Record<string, string> {
    return Deno.env.toObject();
  }
}

const V3_MARKER = '{"format":3,"minReaderFormat":3,"writtenBy":"2026.10.16.5"}';

/** A capable bucket datastore whose control plane holds `config.marker`. */
function extensionSource(type: string): string {
  return `
export const datastore = {
  type: "${type}",
  name: "Test bucket",
  description: "A v3-capable test bucket datastore",
  createProvider: (config) => ({
    createLock: () => { throw new Error("not used"); },
    createVerifier: () => { throw new Error("not used"); },
    resolveDatastorePath: () => "/ds",
    datastoreWideLease: true,
    datastoreControlPlaneStore: () => ({
      get: () =>
        Promise.resolve(
          typeof config.marker === "string"
            ? new TextEncoder().encode(config.marker)
            : null,
        ),
      put: () => Promise.resolve(),
      putIfAbsent: () => Promise.resolve(true),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    }),
    storage: () => { throw new Error("not used"); },
    replicaTarget: () => ({ type: "gcs", bucket: "b", prefix: "" }),
    replicaPaths: () => { throw new Error("not used"); },
  }),
};
`;
}

async function withPulledExtension(
  fn: (
    repo: string,
    name: string,
    setVersion: (v: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "swamp-v3-ext-version-" });
  const id = crypto.randomUUID().slice(0, 8);
  const name = `@test/v3-bucket-${id}`;
  const extDir = join(
    swampPath(repo, "pulled-extensions"),
    "@test",
    `v3-bucket-${id}`,
  );
  const setVersion = (version: string) =>
    Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n`,
    );
  try {
    const datastores = join(extDir, "datastores");
    await Deno.mkdir(datastores, { recursive: true });
    await Deno.writeTextFile(
      join(datastores, "bucket.ts"),
      extensionSource(name),
    );
    await setVersion("2026.10.16.4");
    const result = await new ExtensionLoader(
      new StubDenoRuntime(),
      datastoreKindAdapter,
    ).load(datastores);
    assertEquals(result.failed, []);
    await fn(repo, name, setVersion);
  } finally {
    datastoreTypeRegistry.invalidateType(name);
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
}

function bucketConfig(
  type: string,
  marker: string | null,
  format?: 3,
): CustomDatastoreConfig {
  return {
    type,
    config: { marker },
    datastorePath: "/ds",
    cachePath: "/cache",
    ...(format !== undefined ? { format } : {}),
  };
}

Deno.test("v3 bucket extension version: opening a format-3 datastore refuses a pulled extension below the minimum and accepts it once updated", async () => {
  await withPulledExtension(async (repo, name, setVersion) => {
    const error = await assertRejects(
      () =>
        ensureSupportedDatastoreFormat(repo, bucketConfig(name, V3_MARKER, 3)),
      V3BucketExtensionTooOldError,
    );
    assertStringIncludes(error.message, "its extension is 2026.10.16.4");
    assertStringIncludes(error.message, `swamp extension update ${name}`);

    await setVersion(V3_BUCKET_MIN_EXTENSION_VERSION);
    assertEquals(
      await ensureSupportedDatastoreFormat(
        repo,
        bucketConfig(name, V3_MARKER, 3),
      ),
      "v3",
    );
  });
});

Deno.test("v3 bucket extension version: a .swamp.yaml config with no format stays v2 on an old pulled extension", async () => {
  await withPulledExtension(async (repo, name) => {
    assertEquals(
      await ensureSupportedDatastoreFormat(repo, bucketConfig(name, null)),
      "v2",
    );
  });
});

Deno.test("v3 bucket extension version: setup refuses a current extension the committed lockfile pins below the minimum", async () => {
  await withPulledExtension(async (repo, name, setVersion) => {
    const deps = createDatastoreSetupDeps(
      repo,
      () => Promise.resolve(undefined),
    );
    const lockfileDir = join(repo, "extensions", "models");
    await Deno.mkdir(lockfileDir, { recursive: true });
    const pin = (version: string) =>
      Deno.writeTextFile(
        join(lockfileDir, "upstream_extensions.json"),
        JSON.stringify({
          [name]: { version, pulledAt: "2026-10-16T00:00:00.000Z", files: [] },
        }),
      );

    await assertRejects(
      () => deps.assertV3ExtensionVersion(name, repo),
      V3BucketExtensionTooOldError,
      "its extension is 2026.10.16.4",
    );

    await setVersion(V3_BUCKET_MIN_EXTENSION_VERSION);
    await pin("2026.10.16.3");
    await assertRejects(
      () => deps.assertV3ExtensionVersion(name, repo),
      V3BucketExtensionTooOldError,
      "the repo's lockfile pins its extension at 2026.10.16.3",
    );

    await pin(V3_BUCKET_MIN_EXTENSION_VERSION);
    await deps.assertV3ExtensionVersion(name, repo);
  });
});
