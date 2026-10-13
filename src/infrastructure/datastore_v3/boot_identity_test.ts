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
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { readBootIdentity } from "./boot_identity.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-boot-identity-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when handles are not yet released.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("readBootIdentity: names a Linux boot by the kernel's boot id", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "boot_id");
    await Deno.writeTextFile(file, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\n");
    assertEquals(
      await readBootIdentity("linux", file),
      "boot-id:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    );
  });
});

Deno.test("readBootIdentity: an empty or missing Linux boot id names no boot", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "boot_id");
    await Deno.writeTextFile(file, "\n");
    assertEquals(await readBootIdentity("linux", file), undefined);
    assertEquals(
      await readBootIdentity("linux", join(dir, "missing")),
      undefined,
    );
  });
});

Deno.test("readBootIdentity: names a macOS boot by kern.bootsessionuuid", async () => {
  const { result, calls } = await withMockedCommand(
    [{ stdout: "34301670-7B25-4C97-B717-93EDB30EDD15\n", code: 0 }],
    () => readBootIdentity("darwin"),
  );
  assertEquals(result, "boot-session:34301670-7B25-4C97-B717-93EDB30EDD15");
  assertEquals(calls.map((c) => [c.command, c.args]), [
    ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]],
  ]);
});

Deno.test("readBootIdentity: a failing, empty or throwing sysctl names no boot", async () => {
  for (
    const handler of [
      () => ({ stdout: "", stderr: "unknown oid", code: 1 }),
      () => ({ stdout: "  \n", code: 0 }),
      () => {
        throw new Error("timed out");
      },
    ]
  ) {
    const { result } = await withMockedCommand(
      handler,
      () => readBootIdentity("darwin"),
    );
    assertEquals(result, undefined);
  }
});

Deno.test("readBootIdentity: other systems name no boot and run nothing", async () => {
  const { result, calls } = await withMockedCommand(
    [],
    () => readBootIdentity("windows"),
  );
  assertEquals(result, undefined);
  assertEquals(calls, []);
});
