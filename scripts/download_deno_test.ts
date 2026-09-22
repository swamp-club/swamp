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

// These tests are the only automated coverage this script has: `scripts/` is
// excluded from `deno fmt` and `deno lint` in deno.json, and `deno task check`
// only type-checks the main.ts graph.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  checkVersionAgainstPin,
  parsePinnedDenoVersion,
} from "./download_deno.ts";

/** Captures console.warn output for the duration of `run`. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

Deno.test("parsePinnedDenoVersion: reads the deno line", () => {
  assertEquals(parsePinnedDenoVersion("deno 2.9.6\n"), "2.9.6");
});

Deno.test("parsePinnedDenoVersion: tolerates a leading v", () => {
  assertEquals(parsePinnedDenoVersion("deno v2.9.6\n"), "2.9.6");
});

Deno.test("parsePinnedDenoVersion: picks deno out of a multi-tool file", () => {
  const contents = "node 24\ndeno 2.9.6\nruby 3.3.0\n";
  assertEquals(parsePinnedDenoVersion(contents), "2.9.6");
});

Deno.test("parsePinnedDenoVersion: returns null without a deno line", () => {
  assertEquals(parsePinnedDenoVersion("node 24\n"), null);
});

Deno.test("checkVersionAgainstPin: silent when the version matches", () => {
  const warnings = captureWarnings(() => {
    checkVersionAgainstPin("2.9.6", "2.9.6", true);
  });
  assertEquals(warnings, []);
});

Deno.test("checkVersionAgainstPin: throws on mismatch under CI", () => {
  const error = assertThrows(
    () => checkVersionAgainstPin("2.8.3", "2.9.6", true),
    Error,
  );
  assertStringIncludes(error.message, "2.8.3");
  assertStringIncludes(error.message, "2.9.6");
});

Deno.test("checkVersionAgainstPin: only warns on mismatch off CI", () => {
  const warnings = captureWarnings(() => {
    checkVersionAgainstPin("2.8.3", "2.9.6", false);
  });
  assertEquals(warnings.length, 2);
  assertStringIncludes(warnings.join(" "), "2.9.6");
});

Deno.test("checkVersionAgainstPin: warns rather than throws without a pin", () => {
  const warnings = captureWarnings(() => {
    checkVersionAgainstPin("2.9.6", null, true);
  });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "no deno pin found");
});
