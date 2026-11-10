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
import { join, relative } from "@std/path";
import { collectFiles, headerStatus } from "../scripts/add_license_headers.ts";

Deno.test("headerStatus: all TypeScript files carry the full AGPLv3 copyright header", async () => {
  const root = join(import.meta.dirname!, "..");
  const missing: string[] = [];
  const malformed: string[] = [];

  for (const file of await collectFiles(root)) {
    const status = headerStatus(await Deno.readTextFile(file));
    if (status === "missing") missing.push(relative(root, file));
    if (status === "malformed") malformed.push(relative(root, file));
  }

  const list = (files: string[]) => files.map((f) => `  - ${f}`).join("\n");
  assertEquals(
    [...missing, ...malformed],
    [],
    `${missing.length} file(s) are missing the AGPLv3 copyright header and ` +
      `${malformed.length} have a malformed one.\n` +
      `Run \`deno run license-headers\` to fix them. A header it reports as ` +
      `unrepairable must be fixed by hand against HEADER in ` +
      `scripts/add_license_headers.ts.\n\n` +
      `Missing:\n${list(missing)}\n\nMalformed:\n${list(malformed)}`,
  );
});
