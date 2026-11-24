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
import { UserError } from "../domain/errors.ts";
import {
  assembleDataGetContent,
  CONTENT_PART_CHARS,
  contentPieces,
} from "./data_get_parts.ts";

Deno.test("contentPieces: cuts content into slices of the given size", () => {
  assertEquals([...contentPieces("abcdefg", 3)], ["abc", "def", "g"]);
});

Deno.test("contentPieces: yields nothing for empty content", () => {
  assertEquals([...contentPieces("", 3)], []);
});

Deno.test("contentPieces: never ends a slice between the halves of a surrogate pair", () => {
  const pieces = [...contentPieces("ab😀cd", 3)];
  assertEquals(pieces, ["ab", "😀c", "d"]);
  for (const piece of pieces) {
    assertEquals(piece.isWellFormed(), true);
  }
});

Deno.test("contentPieces: a one-character slice still advances on a surrogate pair", () => {
  assertEquals([...contentPieces("😀", 1)], ["\ud83d", "\ude00"]);
});

Deno.test("contentPieces: the default slice is CONTENT_PART_CHARS", () => {
  const content = "x".repeat(CONTENT_PART_CHARS * 2 + 5);
  assertEquals(
    [...contentPieces(content)].map((piece) => piece.length),
    [CONTENT_PART_CHARS, CONTENT_PART_CHARS, 5],
  );
});

Deno.test("assembleDataGetContent: joins the parts in order and releases them", () => {
  const parts: unknown[] = [{ content: "ab" }, { content: "cd" }];
  assertEquals(assembleDataGetContent(parts, 2, 4), "abcd");
  assertEquals(parts.length, 0);
});

Deno.test("assembleDataGetContent: refuses fewer parts than reported", () => {
  const error = assertThrows(
    () => assembleDataGetContent([{ content: "ab" }], 2, 4),
    UserError,
  );
  assertEquals(
    error.message,
    "The server sent 1 of the 2 content parts it reported. Run the command again.",
  );
});

Deno.test("assembleDataGetContent: refuses a part without string content", () => {
  for (const part of [null, "ab", {}, { content: 4 }]) {
    assertThrows(
      () => assembleDataGetContent([part], 1, 2),
      UserError,
      "content part without content",
    );
  }
});

Deno.test("assembleDataGetContent: refuses content shorter than reported", () => {
  assertThrows(
    () => assembleDataGetContent([{ content: "ab" }], 1, 3),
    UserError,
    "sent 2 of the 3 content characters",
  );
});

Deno.test("assembleDataGetContent: refuses parts without a length", () => {
  assertThrows(
    () => assembleDataGetContent([{ content: "ab" }], 1, undefined),
    UserError,
    "without their length",
  );
});
