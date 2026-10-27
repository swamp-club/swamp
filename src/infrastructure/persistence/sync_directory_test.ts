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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isSyncUnsupported,
  syncDirectoryStrict,
  SyncFailedError,
} from "./sync_directory.ts";

function osError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

Deno.test("syncDirectoryStrict: syncs a directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-sync-dir-test-" });
  try {
    await syncDirectoryStrict(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("syncDirectoryStrict: a directory that is gone is skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-sync-dir-test-" });
  try {
    await syncDirectoryStrict(join(dir, "missing"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isSyncUnsupported: a filesystem that refuses fsync is unsupported, an I/O failure is not", () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF"]) {
    assertEquals(isSyncUnsupported(osError(code, code)), true, code);
  }
  for (const code of ["EIO", "ENOSPC", "EDQUOT", "EROFS"]) {
    assertEquals(isSyncUnsupported(osError(code, code)), false, code);
  }
  assertEquals(isSyncUnsupported(new Error("no code")), false);
  assertEquals(isSyncUnsupported(undefined), false);
});

Deno.test("SyncFailedError: names the path and keeps the cause", () => {
  const cause = osError("EIO", "Input/output error (os error 5)");
  const error = new SyncFailedError("/data/m/state/2/raw", cause);
  assert(error instanceof Error);
  assertEquals(error.name, "SyncFailedError");
  assertEquals(error.path, "/data/m/state/2/raw");
  assertEquals(error.cause, cause);
  assertEquals(
    error.message,
    "Could not sync /data/m/state/2/raw to disk: Input/output error (os error 5).",
  );
});

Deno.test("SyncFailedError: on a filesystem that cannot sync, says how to write without syncing", () => {
  const error = new SyncFailedError(
    "/data/m/state/2/raw",
    osError("EINVAL", "Invalid argument (os error 22)"),
  );
  assertStringIncludes(error.message, "durable: false");
});
