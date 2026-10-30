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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  createQuerySort,
  decodeQueryCursor,
  encodeQueryCursor,
  MAX_QUERY_CURSOR_LENGTH,
  parseQuerySort,
  querySortTagKey,
} from "./query_sort.ts";

const position = {
  key: "2026-10-30T10:00:00.000Z",
  id: ["", "@swamp/agent", "m-1", "session-1", 3] as const,
};

Deno.test("parseQuerySort: reads a field with an optional direction", () => {
  assertEquals(parseQuerySort("createdAt"), {
    field: "createdAt",
    direction: "asc",
  });
  assertEquals(parseQuerySort("tags.startedAt:desc"), {
    field: "tags.startedAt",
    direction: "desc",
  });
});

Deno.test("createQuerySort: refuses other fields, unsafe tag keys and directions", () => {
  for (
    const field of ["name", "attributes.x", "tags.", 'tags.a"b', "tags.a\\b"]
  ) {
    assertThrows(() => createQuerySort(field, "asc"), UserError, "sort by");
  }
  assertThrows(
    () => createQuerySort("createdAt", "up"),
    UserError,
    "direction",
  );
  assertThrows(() => parseQuerySort("tags.x:sideways"), UserError);
});

Deno.test("querySortTagKey: names the tag, or null for createdAt", () => {
  assertEquals(
    querySortTagKey(createQuerySort("tags.started.at", "asc")),
    "started.at",
  );
  assertEquals(querySortTagKey(createQuerySort("createdAt", "asc")), null);
});

Deno.test("decodeQueryCursor: reads back what encodeQueryCursor wrote", () => {
  const sort = createQuerySort("tags.startedAt", "desc");
  const token = encodeQueryCursor(sort, position);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(token), true);
  assertEquals(decodeQueryCursor(token, sort), position);
});

Deno.test("decodeQueryCursor: refuses a cursor made for another sort", () => {
  const token = encodeQueryCursor(
    createQuerySort("tags.startedAt", "desc"),
    position,
  );
  assertThrows(
    () => decodeQueryCursor(token, createQuerySort("tags.startedAt", "asc")),
    UserError,
    "sorted by tags.startedAt:desc",
  );
  assertThrows(
    () => decodeQueryCursor(token, createQuerySort("createdAt", "desc")),
    UserError,
  );
});

Deno.test("decodeQueryCursor: refuses malformed and oversized tokens", () => {
  const sort = createQuerySort("createdAt", "desc");
  const forge = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  const valid = {
    v: 1,
    f: "createdAt",
    d: "desc",
    k: "x",
    id: ["", "t", "m", "n", 1],
  };
  for (
    const token of [
      "",
      "not base64!",
      forge("a string"),
      forge(null),
      forge({ ...valid, v: 2 }),
      forge({ ...valid, k: 5 }),
      forge({ ...valid, id: ["", "t", "m", "n"] }),
      forge({ ...valid, id: ["", "t", "m", 4, 1] }),
      forge({ ...valid, id: ["", "t", "m", "n", 1.5] }),
      "A".repeat(MAX_QUERY_CURSOR_LENGTH + 1),
    ]
  ) {
    assertThrows(
      () => decodeQueryCursor(token, sort),
      UserError,
      "Invalid query cursor",
    );
  }
  assertEquals(decodeQueryCursor(forge(valid), sort).key, "x");
});
