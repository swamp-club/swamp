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
import fc from "fast-check";
import {
  delegatedSecretKindOf,
  delegatedSecretMatches,
  issueDelegatedSecret,
  parseDelegatedSecret,
  RESERVED_TOKEN_NAMES,
} from "./delegated_token.ts";

const KINDS = ["access", "refresh", "redeem"] as const;

Deno.test("delegated secrets: every issued secret parses back to its kind and delegation, and matches only its own hash", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uuid(),
      fc.constantFrom(...KINDS),
      async (id, kind) => {
        const issued = await issueDelegatedSecret(kind, id.toLowerCase());
        assertEquals(parseDelegatedSecret(issued.value), {
          kind,
          delegationId: id.toLowerCase(),
        });
        assertEquals(delegatedSecretKindOf(issued.value), kind);
        // an older node looks up a server token by the text before the first dot
        assert(RESERVED_TOKEN_NAMES.includes(issued.value.split(".")[0]));
        assert(await delegatedSecretMatches(issued.value, issued.hash));
        const other = await issueDelegatedSecret(kind, id.toLowerCase());
        assert(!await delegatedSecretMatches(other.value, issued.hash));
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("delegated secrets: arbitrary text never parses as one", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (text) => {
      const parsed = parseDelegatedSecret(text);
      if (parsed === null) return;
      assert(/^swd[arx]1\.[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(text));
    }),
    { numRuns: 500 },
  );
  assertEquals(parseDelegatedSecret("swda1.not-a-uuid.00"), null);
  assertEquals(delegatedSecretKindOf("swda1.anything"), "access");
  assertEquals(delegatedSecretKindOf("deploy.secret"), null);
});

Deno.test("delegated secrets: no stored hash matches nothing", async () => {
  const issued = await issueDelegatedSecret("access", crypto.randomUUID());
  assert(!await delegatedSecretMatches(issued.value, undefined));
});
