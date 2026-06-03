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
import { UserError } from "../../domain/errors.ts";
import { parseTimeoutFlag } from "./datastore_sync.ts";

Deno.test("parseTimeoutFlag: converts positive integer seconds to milliseconds", () => {
  assertEquals(parseTimeoutFlag(1), 1_000);
  assertEquals(parseTimeoutFlag(60), 60_000);
  assertEquals(parseTimeoutFlag(1800), 1_800_000);
});

Deno.test("parseTimeoutFlag: accepts the upper-bound value (21600s = 6h)", () => {
  assertEquals(parseTimeoutFlag(21_600), 21_600_000);
});

Deno.test("parseTimeoutFlag: rejects zero with a UserError", () => {
  assertThrows(
    () => parseTimeoutFlag(0),
    UserError,
    "--timeout must be greater than 0",
  );
});

Deno.test("parseTimeoutFlag: rejects negative values with a UserError", () => {
  assertThrows(
    () => parseTimeoutFlag(-1),
    UserError,
    "--timeout must be greater than 0",
  );
  assertThrows(
    () => parseTimeoutFlag(-3600),
    UserError,
    "--timeout must be greater than 0",
  );
});

Deno.test("parseTimeoutFlag: rejects values above the 21600s cap", () => {
  assertThrows(
    () => parseTimeoutFlag(21_601),
    UserError,
    "--timeout must be at most 21600 seconds",
  );
  // The error message points users at the env var for higher values —
  // explicit escape hatch for legitimate long-haul migration scenarios.
  assertThrows(
    () => parseTimeoutFlag(99_999),
    UserError,
    "SWAMP_DATASTORE_SYNC_TIMEOUT_MS",
  );
});

Deno.test("parseTimeoutFlag: rejects non-integer numbers", () => {
  assertThrows(
    () => parseTimeoutFlag(1.5),
    UserError,
    "--timeout must be a positive integer",
  );
  assertThrows(
    () => parseTimeoutFlag(Number.NaN),
    UserError,
    "--timeout must be a positive integer",
  );
  assertThrows(
    () => parseTimeoutFlag(Number.POSITIVE_INFINITY),
    UserError,
    "--timeout must be a positive integer",
  );
});

Deno.test("parseTimeoutFlag: rejects non-number inputs defensively", () => {
  // Cliffy's `:integer` parser should deliver a number, but defense in
  // depth — a future refactor that loosens the parser should still surface
  // a clean UserError, not a runtime type error.
  assertThrows(
    () => parseTimeoutFlag("60"),
    UserError,
    "--timeout must be a positive integer",
  );
  assertThrows(
    () => parseTimeoutFlag(null),
    UserError,
    "--timeout must be a positive integer",
  );
  assertThrows(
    () => parseTimeoutFlag(undefined),
    UserError,
    "--timeout must be a positive integer",
  );
});
