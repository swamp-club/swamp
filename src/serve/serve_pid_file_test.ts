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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { removePidFileIfOurs } from "./serve_pid_file.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "pid-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("removePidFileIfOurs: removes the file that names this process", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    await Deno.writeTextFile(path, "4242\n");
    assertEquals(await removePidFileIfOurs(path, 4242), true);
    assertEquals(await Deno.stat(path).then(() => true, () => false), false);
  });
});

Deno.test("removePidFileIfOurs: keeps a file a later serve wrote", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "serve.pid");
    await Deno.writeTextFile(path, "5151");
    assertEquals(await removePidFileIfOurs(path, 4242), false);
    assertEquals(await Deno.readTextFile(path), "5151");
  });
});

Deno.test("removePidFileIfOurs: a missing file is not an error", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await removePidFileIfOurs(join(dir, "serve.pid"), 4242),
      false,
    );
  });
});
