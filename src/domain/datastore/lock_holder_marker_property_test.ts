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
  LOCK_NONCE_PATTERN,
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

Deno.test("withRemoteLockHolder property: a holder on another host hands down exactly its listed locks", () => {
  fc.assert(
    fc.property(
      pidArb,
      fc.uniqueArray(nonceArb, { minLength: 1, maxLength: 8 }),
      nonceArb,
      fc.uniqueArray(pidArb, { maxLength: 8 }),
      (pid, lockIds, otherNonce, workerChain) => {
        fc.pre(!lockIds.includes(otherNonce));
        const chain = workerChain.join(",");
        const env = withRemoteLockHolder(
          { [SWAMP_LOCK_ANCESTOR_PIDS]: chain },
          { pid, hostname: "host-b", lockIds },
          HOST,
        );
        const relationTo = new LockHolderMarker(
          envStore(env),
          CHILD_PID,
          () => HOST,
        ).lockRelation();

        // A pid on another host is never declared an ancestor here.
        assertEquals(env[SWAMP_LOCK_ANCESTOR_PIDS], chain);
        for (const nonce of lockIds) {
          assertEquals(
            relationTo({ pid, hostname: "host-b", nonce }),
            "ancestor",
          );
        }
        assertEquals(
          relationTo({ pid, hostname: "host-b", nonce: otherNonce }),
          "other",
        );
      },
    ),
  );
});

Deno.test("withRemoteLockHolder property: the holder pid never joins the chain without a tokens entry, or from another host", () => {
  fc.assert(
    fc.property(
      fc.oneof(pidArb, fc.integer(), fc.double()),
      fc.array(rawIdArb, { maxLength: 8 }),
      fc.constantFrom(HOST, "host-b"),
      (pid, lockIds, hostname) => {
        const env = withRemoteLockHolder({}, { pid, hostname, lockIds }, HOST);

        const chain = (env[SWAMP_LOCK_ANCESTOR_PIDS] ?? "").split(",");
        const tokens = env[SWAMP_LOCK_HOLDER_TOKENS];
        if (tokens === undefined) {
          assertEquals(env, {});
          return;
        }
        // One entry, for this pid, holding at least one well-formed nonce.
        assertEquals(/^[1-9][0-9]*:[A-Za-z0-9+-]+$/.test(tokens), true);
        assertEquals(tokens.startsWith(`${pid}:`), true);
        assertEquals(chain.includes(String(pid)), hostname === HOST);
      },
    ),
  );
});

Deno.test("LockHolderMarker.lockRelation property: a lock is skipped only for a handed-down nonce or an ancestor's pid on this host", () => {
  const lockArb = (nonces: readonly string[], pids: readonly number[]) =>
    fc.record({
      pid: fc.option(
        pids.length > 0 ? fc.oneof(pidArb, fc.constantFrom(...pids)) : pidArb,
        { nil: undefined },
      ),
      hostname: fc.option(fc.constantFrom(HOST, "host-b"), { nil: undefined }),
      nonce: fc.option(
        nonces.length > 0
          ? fc.oneof(nonceArb, fc.constantFrom(...nonces))
          : nonceArb,
        { nil: undefined },
      ),
    });
  fc.assert(
    fc.property(
      fc.tuple(
        fc.uniqueArray(pidArb, { maxLength: 6 }),
        fc.array(
          fc.tuple(pidArb, fc.array(nonceArb, { maxLength: 4 })),
          { maxLength: 6 },
        ),
      ).chain(([chain, entries]) =>
        fc.tuple(
          fc.constant(chain),
          fc.constant(entries),
          lockArb(entries.flatMap(([, nonces]) => nonces), chain),
        )
      ),
      ([chain, entries, lock]) => {
        const handedDown = new Set(entries.flatMap(([, nonces]) => nonces));
        const relation = new LockHolderMarker(
          envStore({
            [SWAMP_LOCK_ANCESTOR_PIDS]: chain.join(","),
            [SWAMP_LOCK_HOLDER_TOKENS]: entries
              .map(([pid, nonces]) => `${pid}:${nonces.join("+")}`).join(","),
          }),
          CHILD_PID,
          () => HOST,
        ).lockRelation()(lock);

        if (lock.nonce !== undefined && handedDown.has(lock.nonce)) {
          assertEquals(relation, "ancestor");
          return;
        }
        const ancestorHere = lock.pid !== undefined &&
          chain.includes(lock.pid) &&
          (lock.hostname === undefined || lock.hostname === HOST);
        if (!ancestorHere) {
          assertEquals(relation, "other");
          return;
        }
        // Held to its list when it handed one down and the lock has a nonce.
        const listed = entries.some(([pid]) => pid === lock.pid);
        assertEquals(
          relation,
          listed && lock.nonce !== undefined
            ? "ancestor-other-run"
            : "ancestor",
        );
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

/** A well-formed list naming this process and others. */
const listArb = fc.array(
  fc.tuple(
    fc.oneof(fc.constant(OWN_PID), pidArb),
    fc.array(nonceArb, { maxLength: 6 }),
  ),
  { maxLength: 6 },
).map((entries) =>
  entries.map(([pid, nonces]) => `${pid}:${nonces.join("+")}`).join(",")
);

/**
 * The nonces a request handler's child would be told this process holds for
 * it, when the handler adopts `forwarded`.
 */
async function adopted(forwarded: string): Promise<string[]> {
  const server = new LockHolderMarker(envWith(), OWN_PID);
  const tokens = await server.runAdopting(
    forwarded,
    () => Promise.resolve(server.childLockEnv()[SWAMP_LOCK_HOLDER_TOKENS]),
  );
  if (tokens === undefined) return [];
  assert(tokens.startsWith(`${OWN_PID}:`), tokens);
  return tokens.slice(`${OWN_PID}:`.length).split("+");
}

Deno.test("LockHolderMarker.runAdopting: adopts exactly the nonces a list names, whichever pid it names them for", async () => {
  await fc.assert(
    fc.asyncProperty(listArb, async (list) => {
      const named = new Set(
        list.split(",").flatMap((entry) =>
          (entry.split(":")[1] ?? "").split("+")
        ).filter((nonce) => nonce !== ""),
      );
      assertEquals((await adopted(list)).sort(), [...named].sort());
    }),
  );
});

Deno.test("LockHolderMarker.runAdopting: arbitrary input never throws or adopts anything but a well-formed nonce it carries", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), async (forwarded) => {
      for (const nonce of await adopted(forwarded)) {
        assert(LOCK_NONCE_PATTERN.test(nonce), nonce);
        assert(forwarded.includes(nonce), nonce);
      }
    }),
  );
});

Deno.test("LockHolderMarker.forwardedLockTokens: never returns a list over the length limit", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        listArb,
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
