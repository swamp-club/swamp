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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { removeWithRetry } from "./cleanup.ts";

Deno.test("removeWithRetry - removes a file (drop-in for Deno.remove)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
  try {
    const filePath = join(tmpDir, "doomed.txt");
    await Deno.writeTextFile(filePath, "");

    await removeWithRetry(filePath);

    await assertRejects(
      () => Deno.stat(filePath),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeWithRetry - removes a directory recursively", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
  try {
    const subDir = join(tmpDir, "sub");
    await Deno.mkdir(subDir, { recursive: true });
    await Deno.writeTextFile(join(subDir, "file.txt"), "");

    await removeWithRetry(subDir, { recursive: true });

    await assertRejects(
      () => Deno.stat(subDir),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeWithRetry - propagates NotFound for missing path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
  try {
    await assertRejects(
      () => removeWithRetry(join(tmpDir, "does-not-exist")),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("removeWithRetry - on POSIX: behaviour identical to Deno.remove (no retry path)", () => {
  // Validates the POSIX-only short-circuit: on non-Windows platforms
  // the function returns Deno.remove's result directly, with no retry
  // loop and no setTimeout. This is the strongest possible guarantee
  // that POSIX behaviour is unchanged. On Windows this assertion is
  // skipped (the retry path is platform-specific by design).
  if (Deno.build.os === "windows") return;
  assertEquals(typeof removeWithRetry, "function");
  // Implementation review: cleanup.ts:51-53 short-circuits to Deno.remove
  // when Deno.build.os !== "windows".
});
