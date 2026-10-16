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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DatastoreFormatMismatchError,
  InvalidDatastoreFormatMarkerError,
  UnreachableDatastoreFormatMarkerError,
  UnreadableDatastoreFormatMarkerError,
  UnsupportedDatastoreFormatError,
} from "../../domain/datastore/datastore_format.ts";
import type {
  CustomDatastoreConfig,
  FilesystemDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import {
  V3_BUCKET_MIN_EXTENSION_VERSION,
  V3BucketExtensionTooOldError,
  V3HostingUnsupportedError,
} from "../../domain/datastore/v3_hosting.ts";
import { errorPaths } from "../../domain/errors.ts";
import {
  checkedDatastoreEngine,
  datastoreBlockEngine,
  datastoreEngineOf,
  ensureSupportedDatastoreFormat,
  isV2CustomDatastore,
} from "./datastore_format_guard.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-format-guard-" });
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

Deno.test("ensureSupportedDatastoreFormat: a datastore without a marker passes", async () => {
  await withTempDir(async (dir) => {
    await ensureSupportedDatastoreFormat("/repo", {
      type: "filesystem",
      path: dir,
    });
  });
});

Deno.test("ensureSupportedDatastoreFormat: a newer format refuses and marks the file for telemetry redaction", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, DATASTORE_FORMAT_MARKER_FILE);
    await Deno.writeTextFile(path, '{"format":4,"writtenBy":"9.9"}');
    const error = await assertRejects(
      () =>
        ensureSupportedDatastoreFormat("/repo", {
          type: "filesystem",
          path: dir,
        }),
      UnsupportedDatastoreFormatError,
    );
    assertEquals(errorPaths(error), [path]);
  });
});

Deno.test("ensureSupportedDatastoreFormat: an unreadable-as-marker file refuses naming it", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, DATASTORE_FORMAT_MARKER_FILE);
    await Deno.mkdir(path);
    const error = await assertRejects(
      () =>
        ensureSupportedDatastoreFormat("/repo", {
          type: "filesystem",
          path: dir,
        }),
      InvalidDatastoreFormatMarkerError,
    );
    assertEquals(errorPaths(error), [path]);
  });
});

Deno.test("ensureSupportedDatastoreFormat: a config that passed is not read again; a refusal is never remembered", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, DATASTORE_FORMAT_MARKER_FILE);
    const passed: FilesystemDatastoreConfig = { type: "filesystem", path: dir };
    await ensureSupportedDatastoreFormat("/repo", passed);

    await Deno.writeTextFile(path, '{"format":4}');
    // Same object: checked already in this process.
    await ensureSupportedDatastoreFormat("/repo", passed);
    // A new object for the same datastore is checked again.
    const fresh: FilesystemDatastoreConfig = { type: "filesystem", path: dir };
    await assertRejects(
      () => ensureSupportedDatastoreFormat("/repo", fresh),
      UnsupportedDatastoreFormatError,
    );
    await Deno.writeTextFile(path, '{"format":2}');
    await ensureSupportedDatastoreFormat("/repo", fresh);
  });
});

const V3_MARKER = '{"format":3,"minReaderFormat":3,"writtenBy":"2026.10.12.1"}';

Deno.test("ensureSupportedDatastoreFormat: an unmarked datastore opens the v2 engine", async () => {
  await withTempDir(async (dir) => {
    const config: FilesystemDatastoreConfig = { type: "filesystem", path: dir };
    assertEquals(await ensureSupportedDatastoreFormat("/repo", config), "v2");
    assertEquals(checkedDatastoreEngine(config), "v2");
  });
});

Deno.test("ensureSupportedDatastoreFormat: a format-3 filesystem datastore opens the v3 engine", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(
      join(dir, DATASTORE_FORMAT_MARKER_FILE),
      V3_MARKER,
    );
    const config: FilesystemDatastoreConfig = { type: "filesystem", path: dir };
    assertEquals(checkedDatastoreEngine(config), undefined);
    assertEquals(await ensureSupportedDatastoreFormat("/repo", config), "v3");
    assertEquals(checkedDatastoreEngine(config), "v3");
    const asked: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: dir,
      format: 3,
    };
    assertEquals(await ensureSupportedDatastoreFormat("/repo", asked), "v3");
  });
});

Deno.test("ensureSupportedDatastoreFormat: a config asking for v3 without a v3 marker refuses", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(
      () =>
        ensureSupportedDatastoreFormat("/repo", {
          type: "filesystem",
          path: dir,
          format: 3,
        }),
      DatastoreFormatMismatchError,
      "no readable format marker",
    );
  });
});

Deno.test("ensureSupportedDatastoreFormat: a config asking for v2 over a v3 marker refuses", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, DATASTORE_FORMAT_MARKER_FILE);
    await Deno.writeTextFile(path, V3_MARKER);
    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: dir,
      format: 2,
    };
    const error = await assertRejects(
      () => ensureSupportedDatastoreFormat("/repo", config),
      DatastoreFormatMismatchError,
      "marker says format 3",
    );
    assertEquals(errorPaths(error), [path]);
    assertEquals(checkedDatastoreEngine(config), undefined);
  });
});

Deno.test("ensureSupportedDatastoreFormat: a filesystem marker that exists but cannot be read refuses, never opens as v2", async () => {
  if (Deno.build.os === "windows") return;
  await withTempDir(async (dir) => {
    const path = join(dir, DATASTORE_FORMAT_MARKER_FILE);
    await Deno.writeTextFile(path, V3_MARKER);
    await Deno.chmod(path, 0o000);
    try {
      // Root reads any file; the refusal needs a permission error.
      if (await Deno.readFile(path).then(() => true, () => false)) return;
      const error = await assertRejects(
        () =>
          ensureSupportedDatastoreFormat("/repo", {
            type: "filesystem",
            path: dir,
          }),
        UnreadableDatastoreFormatMarkerError,
      );
      assertEquals(errorPaths(error), [path]);
    } finally {
      await Deno.chmod(path, 0o644);
    }
  });
});

/**
 * A custom datastore config and its fake provider (swamp-club#3534): `read`
 * answers each marker read, in order; the provider declares every v3
 * capability unless `capable` is false.
 */
function customDatastore(
  read: Array<() => Promise<Uint8Array | null>>,
  options: {
    capable?: boolean;
    format?: 3;
    override?: true;
    extensionVersion?: string;
  } = {},
) {
  let reads = 0;
  const provider = {
    createLock: () => {
      throw new Error("not used");
    },
    createVerifier: () => {
      throw new Error("not used");
    },
    resolveDatastorePath: () => "/ds",
    datastoreControlPlaneStore: () => ({
      get: () => (read[reads++] ?? read[read.length - 1])(),
      put: () => Promise.resolve(),
      putIfAbsent: () => Promise.resolve(true),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    }),
    ...(options.capable === false ? {} : {
      datastoreWideLease: true as const,
      storage: () => {
        throw new Error("not used");
      },
      replicaTarget: () => ({ type: "gcs" as const, bucket: "b", prefix: "" }),
      replicaPaths: () => {
        throw new Error("not used");
      },
    }),
  };
  const config: CustomDatastoreConfig = {
    type: "@test/bucket",
    config: {},
    datastorePath: "/ds",
    cachePath: "/cache",
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(options.override !== undefined ? { override: options.override } : {}),
  };
  return {
    config,
    reads: () => reads,
    options: {
      resolveProvider: () => Promise.resolve(provider),
      resolveExtensionVersion: () => options.extensionVersion,
      timeoutMs: 50,
      uncappedTimeoutMs: 200,
    },
  };
}

const bytes = (text: string) => () =>
  Promise.resolve(new TextEncoder().encode(text));
const absent = () => Promise.resolve(null);
const failing = () => Promise.reject(new Error("connection reset"));
const never = () => new Promise<Uint8Array | null>(() => {});

Deno.test("ensureSupportedDatastoreFormat: an extension datastore whose config and marker say 3 opens v3 (swamp-club#3534)", async () => {
  const { config, options } = customDatastore([bytes(V3_MARKER)], {
    format: 3,
  });
  assertEquals(
    await ensureSupportedDatastoreFormat("/repo", config, options),
    "v3",
  );
});

Deno.test("ensureSupportedDatastoreFormat: format 3 in the config with no marker is refused (swamp-club#3534)", async () => {
  const { config, options } = customDatastore([absent], { format: 3 });
  await assertRejects(
    () => ensureSupportedDatastoreFormat("/repo", config, options),
    DatastoreFormatMismatchError,
    "no readable format marker",
  );
});

Deno.test("ensureSupportedDatastoreFormat: a format-3 marker opens v3 for an override, and is refused under a .swamp.yaml config with no format (swamp-club#3534)", async () => {
  const override = customDatastore([bytes(V3_MARKER)], { override: true });
  assertEquals(
    await ensureSupportedDatastoreFormat(
      "/repo",
      override.config,
      override.options,
    ),
    "v3",
  );
  // A v2 repo's .swamp.yaml pointed at a v3 bucket: never opened as v3.
  const persisted = customDatastore([bytes(V3_MARKER)]);
  await assertRejects(
    () =>
      ensureSupportedDatastoreFormat(
        "/repo",
        persisted.config,
        persisted.options,
      ),
    DatastoreFormatMismatchError,
    "says format 2, but the datastore's format marker says format 3",
  );
});

Deno.test("ensureSupportedDatastoreFormat: format 3 in the config with an unreadable marker opens v3 provisionally (swamp-club#3534)", async () => {
  for (const read of [failing, never]) {
    const { config, options } = customDatastore([read], { format: 3 });
    assertEquals(
      await ensureSupportedDatastoreFormat("/repo", config, options),
      "v3",
    );
  }
});

Deno.test("ensureSupportedDatastoreFormat: an override on a v3-capable datastore whose marker read is slow is read again, never opened as v2 (swamp-club#3534)", async () => {
  const slowThenV3 = customDatastore([never, bytes(V3_MARKER)], {
    override: true,
  });
  assertEquals(
    await ensureSupportedDatastoreFormat(
      "/repo",
      slowThenV3.config,
      slowThenV3.options,
    ),
    "v3",
  );
  assertEquals(slowThenV3.reads(), 2);

  const slowThenAbsent = customDatastore([never, absent], { override: true });
  assertEquals(
    await ensureSupportedDatastoreFormat(
      "/repo",
      slowThenAbsent.config,
      slowThenAbsent.options,
    ),
    "v2",
  );

  const unreachable = customDatastore([failing], { override: true });
  await assertRejects(
    () =>
      ensureSupportedDatastoreFormat(
        "/repo",
        unreachable.config,
        unreachable.options,
      ),
    UnreachableDatastoreFormatMarkerError,
    "may say format 3",
  );
});

Deno.test("ensureSupportedDatastoreFormat: a .swamp.yaml config with no format keeps v2's skip on an unreadable marker, with one read, though its extension could host v3 (swamp-club#3534)", async () => {
  // Every v2 S3 and GCS repo: offline, it keeps reading from its cache.
  for (const read of [failing, never]) {
    const persisted = customDatastore([read, bytes(V3_MARKER)]);
    assertEquals(
      await ensureSupportedDatastoreFormat(
        "/repo",
        persisted.config,
        persisted.options,
      ),
      "v2",
    );
    assertEquals(persisted.reads(), 1);
  }
});

Deno.test("ensureSupportedDatastoreFormat: a datastore whose extension cannot host v3 keeps v2's skip on an unreadable marker, with one read (swamp-club#3534)", async () => {
  const v2 = customDatastore([failing], { capable: false, override: true });
  assertEquals(
    await ensureSupportedDatastoreFormat("/repo", v2.config, v2.options),
    "v2",
  );
  assertEquals(v2.reads(), 1);
});

Deno.test("ensureSupportedDatastoreFormat: a v3 extension datastore whose extension can no longer host v3 is refused naming the minimum version (swamp-club#3534)", async () => {
  const downgraded = customDatastore([bytes(V3_MARKER)], {
    format: 3,
    capable: false,
  });
  const error = await assertRejects(
    () =>
      ensureSupportedDatastoreFormat(
        "/repo",
        downgraded.config,
        downgraded.options,
      ),
    V3HostingUnsupportedError,
  );
  assertStringIncludes(error.message, V3_BUCKET_MIN_EXTENSION_VERSION);
});

Deno.test("ensureSupportedDatastoreFormat: a v3 extension datastore on an extension older than the minimum is refused naming the update (swamp-club#3567)", async () => {
  const cases = [
    { label: "config 3, marker 3", read: bytes(V3_MARKER), format: 3 as const },
    { label: "config 3, marker unreadable", read: failing, format: 3 as const },
    {
      label: "override, marker 3",
      read: bytes(V3_MARKER),
      override: true as const,
    },
  ];
  for (const { label, read, ...shape } of cases) {
    const old = customDatastore([read], {
      ...shape,
      extensionVersion: "2026.10.16.4",
    });
    const error = await assertRejects(
      () => ensureSupportedDatastoreFormat("/repo", old.config, old.options),
      V3BucketExtensionTooOldError,
      undefined,
      label,
    );
    assertStringIncludes(error.message, "2026.10.16.4");
    assertStringIncludes(error.message, V3_BUCKET_MIN_EXTENSION_VERSION);
    assertStringIncludes(error.message, "swamp extension update @test/bucket");
  }
});

Deno.test("ensureSupportedDatastoreFormat: a v3 extension datastore opens on the minimum, a later or an unknown extension version (swamp-club#3567)", async () => {
  for (
    const extensionVersion of [
      V3_BUCKET_MIN_EXTENSION_VERSION,
      "2026.10.17.1",
      undefined,
      "0.0.0",
    ]
  ) {
    const v3 = customDatastore([bytes(V3_MARKER)], {
      format: 3,
      extensionVersion,
    });
    assertEquals(
      await ensureSupportedDatastoreFormat("/repo", v3.config, v3.options),
      "v3",
    );
  }
});

Deno.test("ensureSupportedDatastoreFormat: a .swamp.yaml config with no format stays v2 on an old extension, offline too (swamp-club#3567)", async () => {
  for (const read of [failing, never, absent]) {
    const v2 = customDatastore([read], { extensionVersion: "2026.10.16.1" });
    assertEquals(
      await ensureSupportedDatastoreFormat("/repo", v2.config, v2.options),
      "v2",
    );
  }
});

Deno.test("datastoreEngineOf: an unchecked extension config is v3 only when it says format 3 (swamp-club#3534)", () => {
  assertEquals(
    datastoreEngineOf({
      type: "@test/bucket",
      config: {},
      datastorePath: "/ds",
      format: 3,
    }),
    "v3",
  );
  assertEquals(
    datastoreEngineOf({
      type: "@test/bucket",
      config: {},
      datastorePath: "/ds",
    }),
    "v2",
  );
});

Deno.test("datastoreBlockEngine: a format-3 extension block is v3 (swamp-club#3534)", () => {
  assertEquals(
    datastoreBlockEngine("/repo", { type: "@swamp/s3-datastore", format: 3 }),
    "v3",
  );
  assertEquals(
    datastoreBlockEngine("/repo", { type: "@swamp/s3-datastore" }),
    "v2",
  );
});

Deno.test("isV2CustomDatastore: an extension datastore is v2 unless it opened as v3 (swamp-club#3534)", () => {
  assertEquals(
    isV2CustomDatastore({
      type: "@test/bucket",
      config: {},
      datastorePath: "/ds",
    }),
    true,
  );
  assertEquals(
    isV2CustomDatastore({
      type: "@test/bucket",
      config: {},
      datastorePath: "/ds",
      format: 3,
    }),
    false,
  );
  assertEquals(isV2CustomDatastore({ type: "filesystem", path: "/ds" }), false);
});
