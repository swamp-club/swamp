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
import { RunStartKey } from "../domain/workflows/run_start_key.ts";
import { RunStartClaims } from "./run_start_claims.ts";

const key = () =>
  RunStartKey.create({
    workflowId: "wf",
    principal: "user:a",
    client: undefined,
    key: "k",
  }, {});

Deno.test("RunStartClaims: a waiter learns the run id when it starts", async () => {
  const claims = new RunStartClaims();
  const claim = claims.claim("l", await key());
  const held = claims.holder("l")!;
  claim.started("run-1");
  assertEquals(await held.started, "run-1");
  assertEquals(claims.holder("l"), held);
  claim.settled();
  assertEquals(claims.holder("l"), undefined);
});

Deno.test("RunStartClaims: a failed attempt frees the key and wakes its waiters", async () => {
  const claims = new RunStartClaims();
  const claim = claims.claim("l", await key());
  const held = claims.holder("l")!;
  claim.settled();
  assertEquals(await held.started, undefined);
  assertEquals(claims.holder("l"), undefined);
});

Deno.test("RunStartClaims: settling twice never frees a later claim", async () => {
  const claims = new RunStartClaims();
  const first = claims.claim("l", await key());
  first.settled();
  claims.claim("l", await key());
  const second = claims.holder("l");
  first.settled();
  assertEquals(claims.holder("l"), second);
});
