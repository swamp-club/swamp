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
import {
  fileAccessOf,
  modeWithAccess,
  readFileAccess,
  satisfiesAccess,
} from "./file_access.ts";

Deno.test("fileAccessOf: classifies execute and group/other bits", () => {
  assertEquals(fileAccessOf(0o644), undefined);
  assertEquals(fileAccessOf(0o664), undefined);
  assertEquals(fileAccessOf(0o755), "executable");
  assertEquals(fileAccessOf(0o744), "executable");
  assertEquals(fileAccessOf(0o600), "private");
  assertEquals(fileAccessOf(0o400), "private");
  assertEquals(fileAccessOf(0o700), "private-executable");
  // The file type bits a stat reports are ignored.
  assertEquals(fileAccessOf(0o100755), "executable");
});

Deno.test("fileAccessOf: a platform without modes records nothing", () => {
  assertEquals(fileAccessOf(null), undefined);
});

Deno.test("modeWithAccess: derives the mode from the created file's bits", () => {
  assertEquals(modeWithAccess(0o644, undefined), 0o644);
  assertEquals(modeWithAccess(0o644, "executable"), 0o755);
  assertEquals(modeWithAccess(0o644, "private"), 0o600);
  assertEquals(modeWithAccess(0o644, "private-executable"), 0o700);
  // A umask of 077 already makes new files private.
  assertEquals(modeWithAccess(0o600, "executable"), 0o700);
  // A umask of 002 keeps group write.
  assertEquals(modeWithAccess(0o664, "executable"), 0o775);
  assertEquals(modeWithAccess(0o100644, "executable"), 0o755);
});

Deno.test("readFileAccess: accepts the three accesses and refuses others", () => {
  assertEquals(readFileAccess(undefined), undefined);
  assertEquals(readFileAccess("executable"), "executable");
  assertEquals(readFileAccess("private"), "private");
  assertEquals(readFileAccess("private-executable"), "private-executable");
  for (const bad of ["", "plain", "755", 0o755, null, {}]) {
    assertThrows(() => readFileAccess(bad), Error, "A file access must be");
  }
});

Deno.test("satisfiesAccess: checks the execute bit and, for private, group and other bits", () => {
  assertEquals(satisfiesAccess(0o644, undefined), true);
  // A restrictive umask makes a plain file private; it is still plain.
  assertEquals(satisfiesAccess(0o600, undefined), true);
  assertEquals(satisfiesAccess(0o755, undefined), false);
  assertEquals(satisfiesAccess(0o755, "executable"), true);
  assertEquals(satisfiesAccess(0o700, "executable"), true);
  assertEquals(satisfiesAccess(0o644, "executable"), false);
  assertEquals(satisfiesAccess(0o600, "private"), true);
  assertEquals(satisfiesAccess(0o640, "private"), false);
  assertEquals(satisfiesAccess(0o700, "private"), false);
  assertEquals(satisfiesAccess(0o700, "private-executable"), true);
  assertEquals(satisfiesAccess(0o755, "private-executable"), false);
});
