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

import { assert } from "@std/assert";
import fc from "fast-check";
import { UserError } from "../domain/errors.ts";
import { UsernameNotFoundError } from "./oauth_client.ts";
import {
  assertAccessListsUsable,
  chooseResolutionMode,
  resolveAccessLists,
  resolvedCacheKey,
  unresolvedCacheKey,
} from "./oauth_access_list_resolution.ts";

const PROVIDER = "https://provider.test";
const NAMES = ["alice", "bob", "carol", "dave", "erin", "frank"];

const arbName = fc.constantFrom(...NAMES);
const arbEntry = fc.oneof(arbName, arbName.map((n) => `user:${n}`));

/**
 * A provider state (which names exist, which fail transiently), a config
 * that satisfies the raw OAuth-mode validation, and a prior cache built
 * from some earlier provider state.
 */
const arbScenario = fc.record({
  existing: fc.subarray(NAMES),
  failing: fc.subarray(NAMES),
  admins: fc.array(arbEntry, { minLength: 1, maxLength: 4 }),
  allowedUsers: fc.array(arbEntry, { maxLength: 4 }),
  allowedCollectives: fc.subarray(["eng", "ops"]),
  cachedExisting: fc.subarray(NAMES),
  cachedMissing: fc.subarray(NAMES),
  retryUnresolved: fc.boolean(),
}).filter((s) => s.allowedUsers.length > 0 || s.allowedCollectives.length > 0);

function priorCache(
  cachedExisting: readonly string[],
  cachedMissing: readonly string[],
): Record<string, string> {
  const cache: Record<string, string> = {};
  for (const name of cachedExisting) {
    cache[resolvedCacheKey("admin", name)] = `sub-${name}`;
    cache[resolvedCacheKey("allowed-user", name)] = `sub-${name}`;
  }
  for (const name of cachedMissing) {
    if (cachedExisting.includes(name)) continue;
    cache[unresolvedCacheKey("admin", name)] = "2026-09-01T00:00:00.000Z";
    cache[unresolvedCacheKey("allowed-user", name)] =
      "2026-09-01T00:00:00.000Z";
  }
  return cache;
}

Deno.test("resolveAccessLists: never lets a skipped name through and never opens admission", async () => {
  await fc.assert(
    fc.asyncProperty(arbScenario, async (s) => {
      const cache = priorCache(s.cachedExisting, s.cachedMissing);
      const mode = chooseResolutionMode(
        s.admins,
        s.allowedUsers,
        cache,
        s.retryUnresolved,
      );
      const resolve = (username: string) => {
        if (s.failing.includes(username)) {
          return Promise.reject(new Error("503"));
        }
        if (s.existing.includes(username)) {
          return Promise.resolve(`sub-${username}`);
        }
        return Promise.reject(new UsernameNotFoundError(username, PROVIDER));
      };

      let result;
      try {
        result = await resolveAccessLists({
          admins: s.admins,
          allowedUsers: s.allowedUsers,
          cache,
          mode,
          resolve: mode === "cached" ? null : resolve,
          providerUrl: PROVIDER,
          now: () => "2026-09-23T12:00:00.000Z",
        });
      } catch (err) {
        // Only full mode may abort, and only on a non-not-found error.
        assert(err instanceof UserError);
        assert(mode === "full");
        return;
      }

      const skipped = new Set(
        result.unresolved.map((u) => `${u.kind}:${u.username}`),
      );
      for (const sub of result.admins) {
        const name = sub.slice("user:sub-".length);
        assert(!skipped.has(`admin:${name}`));
      }
      for (const sub of result.allowedUsers) {
        const name = sub.slice("sub-".length);
        assert(!skipped.has(`allowed-user:${name}`));
      }
      for (const u of result.unresolved) {
        assert(!(`sub-${u.username}` in result.usernamesBySub));
      }

      let usable = true;
      try {
        assertAccessListsUsable(s, result, PROVIDER);
      } catch (err) {
        assert(err instanceof UserError);
        usable = false;
      }
      if (usable) {
        assert(result.admins.length > 0);
        assert(
          result.allowedUsers.length > 0 || s.allowedCollectives.length > 0,
        );
      }
    }),
  );
});
