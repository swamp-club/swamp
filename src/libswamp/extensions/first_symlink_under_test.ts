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
import { firstSymlinkUnder } from "./first_symlink_under.ts";

Deno.test("firstSymlinkUnder: finds a symlink anywhere in a staged tree without following it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "staged-" });
  try {
    await Deno.mkdir(join(dir, "extension", "files"), { recursive: true });
    await Deno.writeTextFile(join(dir, "extension", "manifest.yaml"), "x");
    assertEquals(await firstSymlinkUnder(dir), undefined);

    const link = join(dir, "extension", "files", "notes.md");
    await Deno.symlink(join(dir, "extension", "manifest.yaml"), link, {
      type: "file",
    });
    assertEquals(await firstSymlinkUnder(dir), link);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("firstSymlinkUnder: names the first symlink in name order", async () => {
  const dir = await Deno.makeTempDir({ prefix: "staged-" });
  try {
    const target = join(dir, "target.md");
    await Deno.writeTextFile(target, "x");
    for (const name of ["c.md", "a.md", "b.md"]) {
      await Deno.symlink(target, join(dir, name), { type: "file" });
    }
    assertEquals(await firstSymlinkUnder(dir), join(dir, "a.md"));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
