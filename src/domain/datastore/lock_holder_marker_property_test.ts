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
  type LockHolderEnvStore,
  LockHolderMarker,
  MAX_FORWARDED_LOCK_TOKENS_LENGTH,
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

const OWN_PID = 300;

function envWith(tokens?: string): LockHolderEnvStore {
  return {
    get: (key: string) => key === SWAMP_LOCK_HOLDER_TOKENS ? tokens : undefined,
    set: () => {},
  };
}

const forwardedPidArb = fc.oneof(fc.constant(OWN_PID), pidArb);
/** A well-formed list, biased to name this process and the locks it holds. */
const listArb = (held: readonly string[]) =>
  fc.array(
    fc.tuple(
      forwardedPidArb,
      fc.array(
        held.length > 0
          ? fc.oneof(nonceArb, fc.constantFrom(...held))
          : nonceArb,
        { maxLength: 6 },
      ),
    ),
    { maxLength: 6 },
  ).map((entries) =>
    entries.map(([pid, nonces]) => `${pid}:${nonces.join("+")}`).join(",")
  );

/**
 * The nonces a request handler's child would be told this process holds for
 * it, when the handler adopts `forwarded` while another run holds `held`.
 */
async function adopted(
  held: readonly string[],
  forwarded: string,
): Promise<string[]> {
  const server = new LockHolderMarker(envWith(), OWN_PID);
  let release = () => {};
  const blocked = new Promise<void>((resolve) => release = resolve);
  const run = server.runHolding(held, () => blocked);
  try {
    const tokens = await server.runAdopting(
      forwarded,
      () => Promise.resolve(server.childLockEnv()[SWAMP_LOCK_HOLDER_TOKENS]),
    );
    if (tokens === undefined) return [];
    assert(tokens.startsWith(`${OWN_PID}:`), tokens);
    return tokens.slice(`${OWN_PID}:`.length).split("+");
  } finally {
    release();
    await run;
  }
}

/** The nonces `list` names for this process, as written. */
function namedForOwnPid(list: string): Set<string> {
  const named = new Set<string>();
  for (const entry of list.split(",")) {
    const [pid, nonces] = entry.split(":");
    if (pid === String(OWN_PID)) {
      for (const nonce of (nonces ?? "").split("+")) named.add(nonce);
    }
  }
  return named;
}

Deno.test("LockHolderMarker.runAdopting: adopts exactly the held locks a list names for its own pid", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(nonceArb, { maxLength: 5 }).chain((held) =>
        fc.tuple(fc.constant(held), listArb(held))
      ),
      async ([held, list]) => {
        const named = namedForOwnPid(list);
        assertEquals(
          (await adopted(held, list)).sort(),
          held.filter((nonce) => named.has(nonce)).sort(),
        );
      },
    ),
  );
});

Deno.test("LockHolderMarker.runAdopting: arbitrary input never throws or adopts a lock that is not held", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(nonceArb, { maxLength: 5 }),
      fc.string(),
      async (held, forwarded) => {
        for (const nonce of await adopted(held, forwarded)) {
          assert(held.includes(nonce), nonce);
        }
      },
    ),
  );
});

Deno.test("LockHolderMarker.forwardedLockTokens: never returns a list over the length limit", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        listArb([]),
        fc.integer({ min: 1, max: MAX_FORWARDED_LOCK_TOKENS_LENGTH + 64 })
          .map((length) => `100:${"a".repeat(length)}`),
      ),
      (inherited) => {
        const forwarded = new LockHolderMarker(envWith(inherited), OWN_PID)
          .forwardedLockTokens();
        assert(
          forwarded === undefined ||
            forwarded.length <= MAX_FORWARDED_LOCK_TOKENS_LENGTH,
        );
      },
    ),
  );
});
