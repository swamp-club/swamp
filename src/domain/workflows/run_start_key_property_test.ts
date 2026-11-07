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

import { assert, assertEquals } from "@std/assert";
import * as fc from "fast-check";
import { RunStartKey, runStartLookup } from "./run_start_key.ts";

const identityArb = fc.record({
  workflowId: fc.string({ minLength: 1 }),
  principal: fc.string({ minLength: 1 }),
  client: fc.option(fc.string(), { nil: undefined }),
  key: fc.string({ minLength: 1 }),
});

const inputsArb = fc.dictionary(
  fc.string({ minLength: 1 }).filter((key) => key !== "__proto__"),
  fc.jsonValue(),
);

Deno.test("RunStartKey property: data round-trips and matches its own inputs", async () => {
  await fc.assert(
    fc.asyncProperty(identityArb, inputsArb, async (identity, inputs) => {
      const key = await RunStartKey.create(identity, inputs);
      const read = RunStartKey.fromData(
        JSON.parse(JSON.stringify(key.data)),
      );
      assertEquals(read.data, key.data);
      assert(await read.sameInputs(inputs));
    }),
    { numRuns: 50 },
  );
});

Deno.test("runStartLookup property: distinct identities have distinct lookups", async () => {
  await fc.assert(
    fc.asyncProperty(identityArb, identityArb, async (a, b) => {
      fc.pre(JSON.stringify(a) !== JSON.stringify(b));
      assert(await runStartLookup(a) !== await runStartLookup(b));
    }),
    { numRuns: 50 },
  );
});
