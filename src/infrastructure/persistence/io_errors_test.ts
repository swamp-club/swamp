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
import { isIoError } from "./io_errors.ts";

Deno.test("isIoError: returns true for EMFILE error with code property", () => {
  const error = Object.assign(new Error("Too many open files"), {
    code: "EMFILE",
  });
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for ENFILE error with code property", () => {
  const error = Object.assign(new Error("File table overflow"), {
    code: "ENFILE",
  });
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for EACCES error with code property", () => {
  const error = Object.assign(new Error("Permission denied"), {
    code: "EACCES",
  });
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for EIO error with code property", () => {
  const error = Object.assign(new Error("Input/output error"), {
    code: "EIO",
  });
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for ENOSPC error with code property", () => {
  const error = Object.assign(new Error("No space left on device"), {
    code: "ENOSPC",
  });
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for EMFILE in message without code property", () => {
  const error = new Error("Error: Too many open files (os error 24) EMFILE");
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for 'Too many open files' in message", () => {
  const error = new Error("Too many open files (os error 24)");
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for 'Permission denied' in message", () => {
  const error = new Error("Permission denied (os error 13)");
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns false for YAML parse error", () => {
  const error = new SyntaxError("Unexpected token in YAML at line 3");
  assertEquals(isIoError(error), false);
});

Deno.test("isIoError: returns false for generic Error", () => {
  const error = new Error("Invalid definition data");
  assertEquals(isIoError(error), false);
});

Deno.test("isIoError: returns false for TypeError", () => {
  const error = new TypeError("Cannot read property 'name' of undefined");
  assertEquals(isIoError(error), false);
});

Deno.test("isIoError: returns false for null", () => {
  assertEquals(isIoError(null), false);
});

Deno.test("isIoError: returns false for undefined", () => {
  assertEquals(isIoError(undefined), false);
});

Deno.test("isIoError: returns false for non-object", () => {
  assertEquals(isIoError("EMFILE"), false);
});

Deno.test("isIoError: returns true for EPERM error with code property", () => {
  const error = Object.assign(new Error("Operation not permitted"), {
    code: "EPERM",
  });
  assertEquals(isIoError(error), true);
});

Deno.test("isIoError: returns true for EROFS error with code property", () => {
  const error = Object.assign(new Error("Read-only file system"), {
    code: "EROFS",
  });
  assertEquals(isIoError(error), true);
});
