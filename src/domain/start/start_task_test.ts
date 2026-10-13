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
import { MAX_TASK_BYTES, MAX_TITLE_CHARS, StartTask } from "./start_task.ts";

Deno.test("StartTask.create: trims outer whitespace and keeps the rest", () => {
  const task = StartTask.create("  \n list my pods\n  in prod \n\n");
  assertEquals(task.text, "list my pods\n  in prod");
});

Deno.test("StartTask.create: rejects empty and whitespace-only text", () => {
  assertThrows(() => StartTask.create(""), UserError, "Describe the task");
  assertThrows(
    () => StartTask.create(" \n\t "),
    UserError,
    "Describe the task",
  );
});

Deno.test("StartTask.create: accepts exactly the byte limit", () => {
  const task = StartTask.create("a".repeat(MAX_TASK_BYTES));
  assertEquals(task.text.length, MAX_TASK_BYTES);
});

Deno.test("StartTask.create: rejects text over 32 KiB", () => {
  assertThrows(
    () => StartTask.create("a".repeat(MAX_TASK_BYTES + 1)),
    UserError,
    "longer than 32 KiB",
  );
});

Deno.test("StartTask.create: measures the limit in UTF-8 bytes, not characters", () => {
  // "é" is two bytes in UTF-8.
  const text = "é".repeat(MAX_TASK_BYTES / 2 + 1);
  assertThrows(() => StartTask.create(text), UserError);
});

Deno.test("StartTask.title: is the first non-empty line, trimmed", () => {
  const task = StartTask.create("\n\n   first line  \nsecond");
  assertEquals(task.title(), "first line");
});

Deno.test("StartTask.title: is the whole text when it is one short line", () => {
  assertEquals(
    StartTask.create("check my S3 buckets").title(),
    "check my S3 buckets",
  );
});

Deno.test("StartTask.title: cuts a long line to 120 characters and appends an ellipsis", () => {
  const task = StartTask.create("x".repeat(200));
  const title = task.title();
  assertEquals(title, "x".repeat(MAX_TITLE_CHARS) + "…");
  assertEquals(Array.from(title).length, MAX_TITLE_CHARS + 1);
});

Deno.test("StartTask.title: keeps a line of exactly 120 characters whole", () => {
  const line = "y".repeat(MAX_TITLE_CHARS);
  assertEquals(StartTask.create(line).title(), line);
});

Deno.test("StartTask.title: counts code points, never splitting a surrogate pair", () => {
  const task = StartTask.create("🦆".repeat(130));
  assertEquals(task.title(), "🦆".repeat(MAX_TITLE_CHARS) + "…");
});
