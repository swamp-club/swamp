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
import { createErrorResult, createSuccessResult } from "./invocation_result.ts";

Deno.test("createSuccessResult: returns success status", () => {
  const result = createSuccessResult();
  assertEquals(result.status, "success");
  assertEquals(result.exitCode, 0);
  assertEquals(result.errorType, undefined);
  assertEquals(result.errorMessage, undefined);
});

Deno.test("createErrorResult: redacts home directory paths in errorMessage", () => {
  const error = new Error(
    "Not a swamp repository: /Users/johndoe/projects/myapp",
  );
  const result = createErrorResult(error);
  assertEquals(result.status, "error");
  assertEquals(
    result.errorMessage,
    "Not a swamp repository: /Users/<REDACTED>/projects/myapp",
  );
});

Deno.test("createErrorResult: marks user errors correctly", () => {
  const error = new Error("Invalid argument");
  const result = createErrorResult(error, true);
  assertEquals(result.status, "user_error");
  assertEquals(result.exitCode, 1);
});

Deno.test("createErrorResult: takes only first line of multi-line error", () => {
  const error = new Error("First line\nSecond line\nThird line");
  const result = createErrorResult(error);
  assertEquals(result.errorMessage, "First line");
});

Deno.test("createErrorResult: captures error constructor name as errorType", () => {
  class CustomError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CustomError";
    }
  }
  const error = new CustomError("something failed");
  const result = createErrorResult(error);
  assertEquals(result.errorType, "CustomError");
});
