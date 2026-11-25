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

import { assert } from "@std/assert";
import fc from "fast-check";
import { estimateParsedJsonBytes } from "./resource_load_guard.ts";

const shortStrings = fc.uniqueArray(
  fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 10 }),
  { maxLength: 3000 },
);

Deno.test("estimateParsedJsonBytes: never prices a set of distinct short strings far below one string each", () => {
  fc.assert(
    fc.property(shortStrings, (strings) => {
      const text = new TextEncoder().encode(JSON.stringify(strings));
      const containers = 48 + 8 * strings.length;
      const priced = estimateParsedJsonBytes(text) - containers;
      // the cheapest a distinct string can be priced at is a header and one word
      assert(
        priced >= 0.95 * strings.length * 32,
        `${strings.length} strings priced at ${priced}`,
      );
    }),
  );
});
