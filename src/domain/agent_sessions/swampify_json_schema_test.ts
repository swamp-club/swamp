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
import { fromFileUrl } from "@std/path";
import { SWAMPIFY_JSON_SCHEMA_FILES } from "./swampify.ts";

for (const [file, generate] of SWAMPIFY_JSON_SCHEMA_FILES) {
  Deno.test(`swampify JSON Schema: ${file} matches the zod schema`, async () => {
    const checkedIn = JSON.parse(
      await Deno.readTextFile(
        fromFileUrl(
          new URL(`../../../design/surfaces/${file}`, import.meta.url),
        ),
      ),
    );
    assertEquals(
      checkedIn,
      generate(),
      `design/surfaces/${file} is stale; run \`deno run swampify-schema\``,
    );
  });
}
