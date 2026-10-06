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
import fc from "fast-check";
import {
  type LockHolderEnvStore,
  LockHolderMarker,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_TOKENS,
  withRemoteLockHolder,
} from "./lock_holder_marker.ts";

const HOST = "host-a";
const CHILD_PID = 4_000_000;

function envStore(env: Record<string, string>): LockHolderEnvStore {
  const values = new Map(Object.entries(env));
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const pidArb = fc.integer({ min: 1, max: 3_999_999 });
const nonceArb = fc.uuid();
// Anything a dispatch could carry, including separators of the env format.
const rawIdArb = fc.oneof(nonceArb, fc.string());

Deno.test("withRemoteLockHolder property: a child skips exactly the holder's listed locks", () => {
  fc.assert(
    fc.property(
      pidArb,
      fc.uniqueArray(nonceArb, { minLength: 1, maxLength: 8 }),
      nonceArb,
      fc.uniqueArray(pidArb, { maxLength: 8 }),
      (pid, lockIds, otherNonce, workerChain) => {
        fc.pre(!lockIds.includes(otherNonce));
        const env = withRemoteLockHolder(
          { [SWAMP_LOCK_ANCESTOR_PIDS]: workerChain.join(",") },
          { pid, hostname: HOST, lockIds },
          HOST,
        );
        const relationTo = new LockHolderMarker(
          envStore(env),
          CHILD_PID,
          () => HOST,
        ).lockRelation();

        for (const nonce of lockIds) {
          assertEquals(
            relationTo({ pid, hostname: HOST, nonce }),
            "ancestor",
          );
        }
        assertEquals(
          relationTo({ pid, hostname: HOST, nonce: otherNonce }),
          "ancestor-other-run",
        );
      },
    ),
  );
});

Deno.test("withRemoteLockHolder property: the holder pid never joins the chain without a tokens entry", () => {
  fc.assert(
    fc.property(
      fc.oneof(pidArb, fc.integer(), fc.double()),
      fc.array(rawIdArb, { maxLength: 8 }),
      fc.constantFrom(HOST, "host-b"),
      (pid, lockIds, hostname) => {
        const env = withRemoteLockHolder({}, { pid, hostname, lockIds }, HOST);

        const chain = (env[SWAMP_LOCK_ANCESTOR_PIDS] ?? "").split(",");
        const tokens = env[SWAMP_LOCK_HOLDER_TOKENS] ?? "";
        if (chain.includes(String(pid))) {
          // One entry, for this pid, holding at least one well-formed nonce.
          assertEquals(/^[1-9][0-9]*:[A-Za-z0-9+-]+$/.test(tokens), true);
          assertEquals(tokens.startsWith(`${pid}:`), true);
        } else {
          assertEquals(env, {});
        }
      },
    ),
  );
});
