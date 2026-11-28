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
import fc from "fast-check";
import { outputLogStream } from "./shell_model.ts";

const text = fc.string({ unit: fc.oneof(fc.fullUnicode(), fc.char16bits()) });

Deno.test("outputLogStream: the streamed log equals the joined log for any output and slice size", async () => {
  await fc.assert(
    fc.asyncProperty(
      text,
      text,
      fc.integer({ min: 1, max: 9 }),
      async (stdout, stderr, sliceUnits) => {
        const parts: string[] = [];
        if (stdout) parts.push(`[stdout]\n${stdout}`);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        assertEquals(
          await new Response(outputLogStream(stdout, stderr, sliceUnits))
            .bytes(),
          new TextEncoder().encode(parts.join("\n")),
        );
      },
    ),
  );
});
