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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { replicaPathFenceProblem as testingReplicaPathFenceProblem } from "../../../packages/testing/replica_path_conformance.ts";
import {
  parseReplicaPathFence,
  replicaPathFenceProblem,
} from "./replica_path_store.ts";

/**
 * Fence names and whether they are accepted. Both the core rule and the
 * testing package's copy run over this one list, so the two cannot drift.
 */
const FENCE_FIXTURES: readonly [unknown, boolean][] = [
  ["000000000001", true],
  ["000000000042", true],
  ["123456789012", true],
  ["999999999999", true],
  ["000000000000", false],
  ["", false],
  ["1", false],
  ["00000000001", false],
  ["0000000000001", false],
  ["00000000000a", false],
  ["00000000001/", false],
  ["/00000000001", false],
  ["0000000000.1", false],
  ["../_blobs/00", false],
  ["+00000000001", false],
  ["-00000000001", false],
  [" 00000000001", false],
  ["00000000001 ", false],
  ["1e0000000000", false],
  ["٠".repeat(12), false],
  ["０".repeat(11) + "1", false],
  ["000000000001-conformance", false],
  [1, false],
  [null, false],
  [undefined, false],
];

Deno.test("replicaPathFenceProblem: core and the testing package agree on every fixture", () => {
  for (const [value, accepted] of FENCE_FIXTURES) {
    const label = JSON.stringify(value);
    assertEquals(replicaPathFenceProblem(value) === undefined, accepted, label);
    assertEquals(
      testingReplicaPathFenceProblem(value),
      replicaPathFenceProblem(value),
      label,
    );
  }
});

Deno.test("replicaPathFenceProblem: the reason never repeats the value", () => {
  const problem = replicaPathFenceProblem("secret-value");
  assertStringIncludes(problem!, "12 digits");
  assertEquals(problem!.includes("secret"), false);
});

Deno.test("parseReplicaPathFence: returns the fence a padded name carries", () => {
  assertEquals(parseReplicaPathFence("000000000042"), 42);
  assertEquals(parseReplicaPathFence("999999999999"), 999_999_999_999);
  assertEquals(parseReplicaPathFence("42"), undefined);
  assertEquals(parseReplicaPathFence("000000000000"), undefined);
});
