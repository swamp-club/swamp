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

import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
} from "@std/assert";
import { errorPaths, markErrorPaths, UserError } from "../errors.ts";
import {
  CORRUPT_LOCKFILE_CODE,
  CorruptLockfileError,
  corruptLockfileUserErrorOf,
} from "./corrupt_lockfile_error.ts";

Deno.test("CorruptLockfileError: is a SyntaxError carrying the lockfile path", () => {
  const error = new CorruptLockfileError("Cannot parse lockfile x", "/r/x");
  assertInstanceOf(error, SyntaxError);
  assertEquals(error.message, "Cannot parse lockfile x");
  assertEquals(error.lockfilePath, "/r/x");
  assertEquals(error.name, "CorruptLockfileError");
});

Deno.test("corruptLockfileUserErrorOf: translates a corrupt lockfile error into a coded UserError", () => {
  const error = markErrorPaths(
    new CorruptLockfileError("Cannot parse lockfile /r/x", "/r/x"),
    ["/r/x"],
  );
  const userError = corruptLockfileUserErrorOf(error);
  assertInstanceOf(userError, UserError);
  assertEquals(userError.message, "Cannot parse lockfile /r/x");
  assertEquals(userError.code, CORRUPT_LOCKFILE_CODE);
  assertStrictEquals(userError.cause, error);
  assertEquals(errorPaths(userError), ["/r/x"]);
});

Deno.test("corruptLockfileUserErrorOf: leaves a wrapped corrupt lockfile error to its wrapper", () => {
  const wrapper = new Error("run partly committed", {
    cause: new CorruptLockfileError("Cannot parse lockfile /r/x", "/r/x"),
  });
  assertEquals(corruptLockfileUserErrorOf(wrapper), undefined);
});

Deno.test("corruptLockfileUserErrorOf: ignores other errors", () => {
  assertEquals(corruptLockfileUserErrorOf(new SyntaxError("x")), undefined);
  assertEquals(corruptLockfileUserErrorOf("x"), undefined);
});
