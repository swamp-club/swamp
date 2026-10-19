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
  parseCommaSeparatedLabels,
  parseConcurrency,
  validateMaxDispatches,
  validateOrchestratorUrl,
} from "./worker_shared.ts";
import { UserError } from "../../domain/errors.ts";

Deno.test("parseCommaSeparatedLabels: parses key=value pairs and skips blanks", () => {
  assertEquals(parseCommaSeparatedLabels("a=1, b=2,,"), { a: "1", b: "2" });
});

Deno.test("parseCommaSeparatedLabels: rejects a fragment without key=value", () => {
  assertThrows(
    () => parseCommaSeparatedLabels("a=b,c"),
    UserError,
    "Invalid label 'c' in SWAMP_WORKER_LABELS — expected the form key=value",
  );
});

Deno.test("validateOrchestratorUrl: accepts ws and wss", () => {
  validateOrchestratorUrl("ws://orch:9090");
  validateOrchestratorUrl("wss://orch:9090");
});

Deno.test("validateOrchestratorUrl: rejects other schemes and redacts the URL", () => {
  assertThrows(
    () => validateOrchestratorUrl("https://user:secret@orch:9090"),
    UserError,
    "Orchestrator URL must start with ws:// or wss://",
  );
  const err = assertThrows(
    () => validateOrchestratorUrl("https://user:secret@orch:9090"),
    UserError,
  );
  assertEquals(err.message.includes("secret"), false);
});

Deno.test("validateMaxDispatches: accepts a positive integer", () => {
  validateMaxDispatches(1);
  validateMaxDispatches(100);
});

Deno.test("validateMaxDispatches: rejects zero, negatives, fractions and NaN", () => {
  for (const n of [0, -1, 1.5, NaN]) {
    assertThrows(
      () => validateMaxDispatches(n),
      UserError,
      "--max-dispatches must be a positive integer",
    );
  }
});

Deno.test("parseConcurrency: parses a positive integer", () => {
  assertEquals(parseConcurrency("4"), 4);
});

Deno.test("parseConcurrency: auto is the CPU count, at least 1", () => {
  assertEquals(
    parseConcurrency("auto"),
    Math.max(1, navigator.hardwareConcurrency ?? 1),
  );
});

Deno.test("parseConcurrency: rejects zero, fractions and words", () => {
  for (const raw of ["0", "-2", "1.5", "many", ""]) {
    assertThrows(
      () => parseConcurrency(raw),
      UserError,
      '--concurrency must be a positive integer or "auto"',
    );
  }
});
