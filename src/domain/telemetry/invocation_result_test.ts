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

Deno.test("createErrorResult: removes marked Windows paths whose last segment has a space", () => {
  const cases = [
    String.raw`C:\Users\John Smith\Acme Corp\final report.yaml`,
    "C:/Users/John Smith/Acme Corp/final report",
    String.raw`\\fileserver\share\Acme Corp\final report`,
    String.raw`D:\data\final report`,
  ];
  for (const path of cases) {
    const error = markErrorPaths(
      new UserError(`Failed to read ${path}: denied`),
      [path],
    );
    assertEquals(
      createErrorResult(error, true).errorMessage,
      "Failed to read <PATH>: denied",
      path,
    );
  }
});

Deno.test("createErrorResult: removes a marked Windows path quoted by a runtime error", () => {
  const path = String.raw`C:\Users\John Smith\final report`;
  const inner = markErrorPaths(
    new Error(
      `The system cannot find the file specified. (os error 2): readfile '${path}'`,
    ),
    [path],
  );
  const error = new Error(`Load failed: ${inner.message}`, { cause: inner });
  assertEquals(
    createErrorResult(error).errorMessage,
    "Load failed: The system cannot find the file specified. (os error 2): readfile '<PATH>'",
  );
});

Deno.test("createErrorResult: a wait id typed in upper case is removed from a workflow signal error line", () => {
  const typed = "6F1C0A52-3F0E-4C4B-9D53-2F6A7C1E8B90";
  // The message names the id as typed, which is what telemetry knows.
  const result = createErrorResult(
    new Error(
      `Wait ${typed} is already settled: step "review" of workflow "release" (run r-1) received signal s-1.`,
    ),
    true,
    [typed],
  );

  assertEquals(result.errorMessage?.includes(typed), false);
  assertEquals(result.errorMessage?.includes(typed.toLowerCase()), false);
});
