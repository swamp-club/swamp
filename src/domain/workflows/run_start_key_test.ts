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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { RunStartKey, runStartLookup } from "./run_start_key.ts";

const identity = {
  workflowId: "wf-1",
  principal: "user:alice",
  client: "integration:app",
  key: "button-1",
};

Deno.test("runStartLookup: differs by workflow, person, client and key", async () => {
  const base = await runStartLookup(identity);
  for (
    const other of [
      { workflowId: "wf-2" },
      { principal: "user:bob" },
      { client: "direct:cli" },
      { client: undefined },
      { key: "button-2" },
    ]
  ) {
    assertNotEquals(await runStartLookup({ ...identity, ...other }), base);
  }
  assertEquals(await runStartLookup({ ...identity }), base);
});

Deno.test("runStartLookup: a separator in a value cannot make two identities collide", async () => {
  assertNotEquals(
    await runStartLookup({ ...identity, principal: "a", key: "b,c" }),
    await runStartLookup({ ...identity, principal: "a,b", key: "c" }),
  );
});

Deno.test("RunStartKey: holds neither the caller's key nor the inputs", async () => {
  const key = await RunStartKey.create(identity, { secret: "hunter2" });
  const stored = JSON.stringify(key.data);
  assertEquals(stored.includes("button-1"), false);
  assertEquals(stored.includes("hunter2"), false);
});

Deno.test("RunStartKey: two records of the same inputs share no fingerprint", async () => {
  const a = await RunStartKey.create(identity, { secret: "hunter2" });
  const b = await RunStartKey.create(identity, { secret: "hunter2" });
  assertEquals(a.lookup, b.lookup);
  assertNotEquals(a.data.fingerprint, b.data.fingerprint);
});

Deno.test("RunStartKey.sameInputs: ignores key order and tells values apart", async () => {
  const key = await RunStartKey.create(identity, {
    a: 1,
    nested: { x: 1, y: 2 },
  });
  assert(await key.sameInputs({ nested: { y: 2, x: 1 }, a: 1 }));
  assertEquals(await key.sameInputs({ a: 2, nested: { x: 1, y: 2 } }), false);
  assertEquals(await key.sameInputs({}), false);
});

Deno.test("RunStartKey.fromData: round-trips and refuses a malformed record", async () => {
  const key = await RunStartKey.create(identity, { a: 1 });
  const read = RunStartKey.fromData(key.data);
  assertEquals(read.data, key.data);
  assert(await read.sameInputs({ a: 1 }));
  let refused = false;
  try {
    RunStartKey.fromData({ lookup: "", salt: "s", fingerprint: "f" });
  } catch {
    refused = true;
  }
  assert(refused);
});
