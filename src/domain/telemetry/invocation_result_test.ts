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
import { markErrorPaths, UserError } from "../errors.ts";
import { createErrorResult, createSuccessResult } from "./invocation_result.ts";

Deno.test("createSuccessResult: returns success status", () => {
  const result = createSuccessResult();
  assertEquals(result.status, "success");
  assertEquals(result.exitCode, 0);
  assertEquals(result.errorType, undefined);
  assertEquals(result.errorMessage, undefined);
});

Deno.test("createErrorResult: redacts paths in errorMessage", () => {
  const error = new Error(
    "Not a swamp repository: /Users/johndoe/projects/myapp",
  );
  const result = createErrorResult(error);
  assertEquals(result.status, "error");
  assertEquals(
    result.errorMessage,
    "Not a swamp repository: <PATH>",
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

Deno.test("createErrorResult: removes a marked path whose last segment has a space", () => {
  const path = "/srv/acme/discovered/final report";
  const error = markErrorPaths(
    new UserError(`Failed to read definition file ${path}: denied`),
    [path],
  );
  const result = createErrorResult(error, true);
  assertEquals(
    result.errorMessage,
    "Failed to read definition file <PATH>: denied",
  );
});

Deno.test("createErrorResult: removes paths marked on the cause chain", () => {
  const path = "/srv/acme/discovered/final report";
  const inner = markErrorPaths(new Error(`open ${path}`), [path]);
  const error = new Error(`Load failed: ${inner.message}`, { cause: inner });
  const result = createErrorResult(error);
  assertEquals(result.errorMessage, "Load failed: open <PATH>");
});

Deno.test("createErrorResult: leaves a marked value that is not a path to the patterns", () => {
  const error = markErrorPaths(
    new UserError(`Custom tool "root" escapes the repository root.`),
    ["root"],
  );
  const result = createErrorResult(error, true);
  assertEquals(
    result.errorMessage,
    `Custom tool "root" escapes the repository root.`,
  );
});
