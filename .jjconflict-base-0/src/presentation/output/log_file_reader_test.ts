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
import { readLogFile } from "./log_file_reader.ts";

Deno.test("readLogFile - reads file lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "line 1\nline 2\nline 3\n");
    const result = await readLogFile(tmpFile);
    assertEquals(result.lines, ["line 1", "line 2", "line 3"]);
    assertEquals(result.path, tmpFile);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readLogFile - handles missing file", async () => {
  const result = await readLogFile("/nonexistent/path/file.log");
  assertEquals(result.lines, []);
  assertEquals(result.path, "/nonexistent/path/file.log");
});

Deno.test("readLogFile - tail option returns last N lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(
      tmpFile,
      "line 1\nline 2\nline 3\nline 4\nline 5\n",
    );
    const result = await readLogFile(tmpFile, { tail: 2 });
    assertEquals(result.lines, ["line 4", "line 5"]);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readLogFile - empty file", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "");
    const result = await readLogFile(tmpFile);
    assertEquals(result.lines, []);
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("readLogFile - tail larger than file returns all lines", async () => {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, "line 1\nline 2\n");
    const result = await readLogFile(tmpFile, { tail: 100 });
    assertEquals(result.lines, ["line 1", "line 2"]);
  } finally {
    await Deno.remove(tmpFile);
  }
});
