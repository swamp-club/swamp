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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  boundIndexedInputs,
  INDEXED_INPUT_MAX_BYTES,
  INDEXED_INPUTS_MAX_BYTES,
} from "./workflow_run_summary.ts";

const utf8 = new TextEncoder();
const bytesOf = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

const inputs = fc.dictionary(
  fc.string({ maxLength: 12 }),
  fc.oneof(
    fc.string({ maxLength: 3000 }),
    fc.integer(),
    fc.boolean(),
    fc.array(fc.string({ maxLength: 400 }), { maxLength: 6 }),
  ),
  { maxKeys: 30 },
);

Deno.test("boundIndexedInputs: kept values stay within budget and equal the originals", () => {
  fc.assert(
    fc.property(inputs, (original) => {
      const { inputs: kept, omitted } = boundIndexedInputs(original);
      let total = 0;
      for (const [key, value] of Object.entries(kept)) {
        assertEquals(value, original[key]);
        const bytes = bytesOf(value);
        assert(bytes <= INDEXED_INPUT_MAX_BYTES);
        total += bytes;
      }
      assert(total <= INDEXED_INPUTS_MAX_BYTES);
      assertEquals(
        [...Object.keys(kept), ...omitted].sort(),
        Object.keys(original).sort(),
      );
    }),
  );
});
