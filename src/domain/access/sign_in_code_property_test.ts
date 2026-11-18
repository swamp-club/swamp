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
import { SIGN_IN_CODE_TTL_MS, SignInCodeStore } from "./sign_in_code.ts";

const T0 = Date.parse("2026-11-18T12:00:00.000Z");
const GRANT = {
  principal: "user:sub-alice",
  username: "alice",
  email: null,
  collectives: [],
  groups: [],
  expiresAt: new Date(T0 + 86_400_000).toISOString(),
};

const workspaceName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}$/);

Deno.test("SignInCodeStore property: a code is redeemed at most once, whatever the attempts", async () => {
  await fc.assert(
    fc.asyncProperty(
      workspaceName,
      fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
      async (name, rightName) => {
        const store = new SignInCodeStore({ now: () => T0 });
        const issued = await store.issue(name, GRANT);
        assert(issued.ok);
        let granted = 0;
        for (const right of rightName) {
          const result = await store.redeem(
            issued.code,
            right ? name : `${name}x`,
          );
          if (result !== null) granted++;
        }
        assert(granted <= 1);
        assertEquals(granted === 1, rightName[0]);
      },
    ),
  );
});

Deno.test("SignInCodeStore property: a code is good only for the exact name it was bound to", async () => {
  await fc.assert(
    fc.asyncProperty(workspaceName, workspaceName, async (bound, taken) => {
      const store = new SignInCodeStore({ now: () => T0 });
      const issued = await store.issue(bound, GRANT);
      assert(issued.ok);
      const result = await store.redeem(issued.code, taken);
      assertEquals(result !== null, bound === taken);
    }),
  );
});

Deno.test("SignInCodeStore property: a code is good strictly before its TTL ends, and never after", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: SIGN_IN_CODE_TTL_MS * 3 }),
      async (elapsed) => {
        let now = T0;
        const store = new SignInCodeStore({ now: () => now });
        const issued = await store.issue("edge-dns", GRANT);
        assert(issued.ok);
        now += elapsed;
        const result = await store.redeem(issued.code, "edge-dns");
        assertEquals(result !== null, elapsed < SIGN_IN_CODE_TTL_MS);
        assertEquals(store.size, 0);
      },
    ),
  );
});

Deno.test("SignInCodeStore property: no principal holds more than its cap of outstanding codes", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.array(fc.constantFrom("user:a", "user:b", "user:c"), {
        maxLength: 30,
      }),
      async (cap, principals) => {
        const store = new SignInCodeStore({
          now: () => T0,
          maxPerPrincipal: cap,
        });
        const held = new Map<string, number>();
        for (const principal of principals) {
          const result = await store.issue("edge-dns", {
            ...GRANT,
            principal,
          });
          const count = held.get(principal) ?? 0;
          assertEquals(result.ok, count < cap);
          if (result.ok) held.set(principal, count + 1);
        }
      },
    ),
  );
});
