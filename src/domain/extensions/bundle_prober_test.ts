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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { describeProbeFailure, ProbeFailedError } from "./bundle_prober.ts";
import { ValidationError } from "./validation_error.ts";

Deno.test("ProbeFailedError: is a ValidationError, so the source is recorded as deterministic", () => {
  const error = new ProbeFailedError("did not finish", "/b/x.js", "fp");
  assert(error instanceof ValidationError);
  assertEquals(error.name, "ProbeFailedError");
  assertEquals(error.bundlePath, "/b/x.js");
  assertEquals(error.fingerprint, "fp");
});

Deno.test("describeProbeFailure: names a timeout and how to retry", () => {
  const message = describeProbeFailure({ tag: "timed-out", timeoutMs: 10000 });
  assertStringIncludes(message, "did not finish within 10000ms");
  assertStringIncludes(message, "Edit the file to retry");
});

Deno.test("describeProbeFailure: names an exit and its code", () => {
  const message = describeProbeFailure({ tag: "exited", code: 3 });
  assertStringIncludes(message, "called exit(3) at import");
  assertStringIncludes(message, "Edit the file to retry");
});
