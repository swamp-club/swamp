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
import {
  admitsNestedRun,
  formatNestedGatePass,
  type NestedGatePass,
  parseNestedGatePass,
} from "./nested_gate_pass.ts";

const PASS: NestedGatePass = {
  parentPid: 4242,
  proof: '{"fpr":"abc","iat":1,"kid":"k","org":[],"scopes":[],"sub":"u"}',
  signature: "c2lnbmF0dXJl",
};

Deno.test("formatNestedGatePass: prefixes the signin-token encoding with the pid", () => {
  const value = formatNestedGatePass(PASS);
  const [pid, proofB64, signature] = value.split(".");
  assertEquals(pid, "4242");
  assertEquals(signature, PASS.signature);
  assertEquals(proofB64.includes("="), false);
});

Deno.test("parseNestedGatePass: reads back what formatNestedGatePass wrote", () => {
  assertEquals(parseNestedGatePass(formatNestedGatePass(PASS)), PASS);
});

Deno.test("parseNestedGatePass: rejects a value without a pid", () => {
  const [, proofB64, signature] = formatNestedGatePass(PASS).split(".");
  assertEquals(parseNestedGatePass(`${proofB64}.${signature}`), null);
});

Deno.test("parseNestedGatePass: rejects a pid that is not a positive integer", () => {
  const rest = formatNestedGatePass(PASS).split(".").slice(1).join(".");
  for (
    const pid of ["0", "-1", "01", "1.5", "abc", "", "99999999999999999999"]
  ) {
    assertEquals(parseNestedGatePass(`${pid}.${rest}`), null, pid);
  }
});

Deno.test("parseNestedGatePass: rejects a proof that is not JSON", () => {
  const notJson = btoa("not json").replace(/=+$/, "");
  assertEquals(parseNestedGatePass(`42.${notJson}.c2ln`), null);
});

Deno.test("parseNestedGatePass: rejects non-base64url parts", () => {
  assertEquals(parseNestedGatePass("42.e30=.c2ln"), null);
  assertEquals(parseNestedGatePass("42.e30.c2l+"), null);
  assertEquals(parseNestedGatePass("42..c2ln"), null);
  assertEquals(parseNestedGatePass(""), null);
});

Deno.test("admitsNestedRun: a proof still valid when the ancestor started admits it", () => {
  assertEquals(admitsNestedRun({ exp: 2_000 }, 1_999), true);
  // Expired since: the ancestor was admitted on it, so its children are too.
  assertEquals(admitsNestedRun({ exp: 2_000 }, 1_000), true);
});

Deno.test("admitsNestedRun: a proof expired before the ancestor started does not", () => {
  assertEquals(admitsNestedRun({ exp: 2_000 }, 2_000), false);
  assertEquals(admitsNestedRun({ exp: 2_000 }, 3_000), false);
});

Deno.test("admitsNestedRun: a proof without exp (a signin token) never does", () => {
  assertEquals(admitsNestedRun({}, 0), false);
});
