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

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { ValidationError } from "./validation_error.ts";

Deno.test("ValidationError: extends Error and carries bundlePath + fingerprint", () => {
  const err = new ValidationError(
    "Invalid input: expected object, received string",
    "/tmp/repo/.swamp/bundles/abc/test/entry.js",
    "sha256-abc123",
  );

  assertInstanceOf(err, Error);
  assertInstanceOf(err, ValidationError);
  assertEquals(err.name, "ValidationError");
  assertEquals(
    err.message,
    "Invalid input: expected object, received string",
  );
  assertEquals(
    err.bundlePath,
    "/tmp/repo/.swamp/bundles/abc/test/entry.js",
  );
  assertEquals(err.fingerprint, "sha256-abc123");
});

Deno.test("ValidationError: instanceof distinguishes from plain Error", () => {
  const validationErr = new ValidationError("bad schema", "/bundle.js", "fp");
  const plainErr = new Error("bundle build failed");

  assert(validationErr instanceof ValidationError);
  assert(!(plainErr instanceof ValidationError));
});
