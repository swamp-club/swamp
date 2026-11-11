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
  findDuplicateJsonKey,
  type JsonPathSegment,
} from "./json_duplicate_keys.ts";

Deno.test("findDuplicateJsonKey: JSON.stringify output never repeats a key", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.boolean(), (value, indent) => {
      const content = JSON.stringify(value, null, indent ? 2 : undefined);
      assertEquals(findDuplicateJsonKey(content), undefined);
    }),
  );
});

const arbSegment: fc.Arbitrary<JsonPathSegment> = fc.oneof(
  fc.string(),
  fc.nat({ max: 3 }),
);

function wrap(content: string, path: JsonPathSegment[]): string {
  let text = content;
  for (const segment of [...path].reverse()) {
    text = typeof segment === "number"
      ? `[${[...Array(segment).fill("0"), text].join(",")}]`
      : `{${JSON.stringify(segment)}:${text}}`;
  }
  return text;
}

Deno.test("findDuplicateJsonKey: a key repeated at any depth is reported with its path", () => {
  fc.assert(
    fc.property(
      fc.array(arbSegment, { maxLength: 6 }),
      fc.uniqueArray(fc.tuple(fc.string(), fc.jsonValue()), {
        minLength: 1,
        maxLength: 5,
        selector: ([key]) => key,
      }),
      fc.nat(),
      fc.nat(),
      fc.jsonValue(),
      (path, entries, pick, position, repeatedValue) => {
        const key = entries[pick % entries.length][0];
        const members = entries.map(([k, v]) =>
          `${JSON.stringify(k)}:${JSON.stringify(v)}`
        );
        members.splice(
          position % (members.length + 1),
          0,
          `${JSON.stringify(key)}:${JSON.stringify(repeatedValue)}`,
        );
        const content = wrap(`{${members.join(",")}}`, path);
        JSON.parse(content);
        assertEquals(findDuplicateJsonKey(content), { key, path });
      },
    ),
  );
});
