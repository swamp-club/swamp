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
import {
  formatSelector,
  parseSelector,
  type Selector,
} from "./host_map_model.ts";

const word = fc.stringMatching(/^[a-z0-9][a-z0-9._/-]{0,11}$/);
const labelKey = word.filter((k) =>
  k !== "platform" && k !== "target" && !k.includes("/")
);

const selectorArb: fc.Arbitrary<Selector> = fc.record({
  labels: fc.dictionary(labelKey, word, { maxKeys: 5 }),
  platform: fc.option(word, { nil: undefined }),
  target: fc.option(word, { nil: undefined }),
}).map((s) => {
  const out: Selector = { labels: s.labels };
  if (s.platform !== undefined) out.platform = s.platform;
  if (s.target !== undefined) out.target = s.target;
  return out;
});

Deno.test("parseSelector: round-trips formatSelector output", () => {
  fc.assert(
    fc.property(selectorArb, (selector) => {
      const parsed = parseSelector(formatSelector(selector));
      assertEquals(parsed.invalid, []);
      assertEquals(parsed.selector, selector);
    }),
  );
});

Deno.test("parseSelector: never throws and reports every non key=value token", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (text) => {
      const { invalid } = parseSelector(text);
      for (const token of invalid) {
        const eq = token.indexOf("=");
        assertEquals(eq <= 0 || eq === token.length - 1, true);
      }
    }),
  );
});
