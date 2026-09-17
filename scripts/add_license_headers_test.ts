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
import { collectFiles } from "./add_license_headers.ts";

Deno.test("collectFiles: includes source files from a checkout beneath .claude", async () => {
  const parent = await Deno.makeTempDir();
  const root = join(parent, ".claude", "worktrees", "checkout");
  const sourceFile = join(root, "src", "needs_header.ts");
  const skippedFile = join(root, "src", ".claude", "ignored.ts");

  try {
    await Deno.mkdir(join(root, "src", ".claude"), { recursive: true });
    await Deno.writeTextFile(sourceFile, "export const needsHeader = true;\n");
    await Deno.writeTextFile(skippedFile, "export const ignored = true;\n");

    assertEquals(await collectFiles(root), [sourceFile]);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});
