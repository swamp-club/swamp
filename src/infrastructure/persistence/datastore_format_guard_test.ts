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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DatastoreFormatMismatchError,
  InvalidDatastoreFormatMarkerError,
  UnreadableDatastoreFormatMarkerError,
  UnsupportedDatastoreFormatError,
} from "../../domain/datastore/datastore_format.ts";
import type { FilesystemDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { errorPaths } from "../../domain/errors.ts";
import {
  checkedDatastoreEngine,
  ensureSupportedDatastoreFormat,
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
