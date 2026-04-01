// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { deleteBeforeCursor, insertAtCursor } from "./cel_input.tsx";

// insertAtCursor

Deno.test("insertAtCursor: inserts at beginning", () => {
  const result = insertAtCursor("hello", 0, "X");
  assertEquals(result, { text: "Xhello", cursorPos: 1 });
});

Deno.test("insertAtCursor: inserts in middle", () => {
  const result = insertAtCursor("hello", 2, "X");
  assertEquals(result, { text: "heXllo", cursorPos: 3 });
});

Deno.test("insertAtCursor: inserts at end", () => {
  const result = insertAtCursor("hello", 5, "X");
  assertEquals(result, { text: "helloX", cursorPos: 6 });
});

Deno.test("insertAtCursor: inserts multi-char string", () => {
  const result = insertAtCursor("ab", 1, "XYZ");
  assertEquals(result, { text: "aXYZb", cursorPos: 4 });
});

Deno.test("insertAtCursor: inserts into empty string", () => {
  const result = insertAtCursor("", 0, "a");
  assertEquals(result, { text: "a", cursorPos: 1 });
});

// deleteBeforeCursor

Deno.test("deleteBeforeCursor: deletes in middle", () => {
  const result = deleteBeforeCursor("hello", 3);
  assertEquals(result, { text: "helo", cursorPos: 2 });
});

Deno.test("deleteBeforeCursor: deletes at end", () => {
  const result = deleteBeforeCursor("hello", 5);
  assertEquals(result, { text: "hell", cursorPos: 4 });
});

Deno.test("deleteBeforeCursor: no-op at position 0", () => {
  const result = deleteBeforeCursor("hello", 0);
  assertEquals(result, { text: "hello", cursorPos: 0 });
});

Deno.test("deleteBeforeCursor: deletes first char", () => {
  const result = deleteBeforeCursor("hello", 1);
  assertEquals(result, { text: "ello", cursorPos: 0 });
});

Deno.test("deleteBeforeCursor: single char string", () => {
  const result = deleteBeforeCursor("a", 1);
  assertEquals(result, { text: "", cursorPos: 0 });
});
