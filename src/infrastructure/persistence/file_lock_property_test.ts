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
import { join } from "@std/path";
import fc from "fast-check";
import {
  FileLock,
  type LockFileHandle,
  type LockFileOps,
  type LockFileState,
  nextBackoffSleep,
} from "./file_lock.ts";

Deno.test("nextBackoffSleep: sleep and next backoff never exceed the cap or the budget", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 100_000 }),
      fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
      fc.integer({ min: -1_000, max: 120_000 }),
      fc.integer({ min: 1, max: 60_000 }),
      (currentBackoffMs, jitterSample, remainingMs, maxBackoffMs) => {
        const { sleepMs, nextBackoffMs } = nextBackoffSleep(
          currentBackoffMs,
          jitterSample,
          remainingMs,
          maxBackoffMs,
        );
        assert(sleepMs <= maxBackoffMs, `sleep ${sleepMs} > cap`);
        assert(sleepMs <= remainingMs, `sleep ${sleepMs} > remaining`);
        assert(nextBackoffMs <= maxBackoffMs, `next ${nextBackoffMs} > cap`);
      },
    ),
  );
});

function isLockRecord(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

Deno.test("FileLock.inspect: any content that is not a lock record reads as held while fresh and as no lock once stale", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-property-" });
  try {
    const lockPath = join(dir, ".datastore.lock");
    const lock = new FileLock(dir, { ttlMs: 5_000 });
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((content) => !isLockRecord(content)),
        async (content) => {
          await Deno.writeTextFile(lockPath, content);
          // set the mtime outright: rewriting an empty file with empty content
          // leaves it untouched on Windows, so the previous run's stale mtime
          // would survive
          const now = new Date();
          await Deno.utime(lockPath, now, now);
          const fresh = await lock.inspect();
          assert(fresh !== null, "fresh must read as held");
          assertEquals(fresh.holderUnknown, true);
          assertEquals(fresh.nonce, undefined);

          const past = new Date(Date.now() - 10_000);
          await Deno.utime(lockPath, past, past);
          assertEquals(await lock.inspect(), null);
        },
      ),
      { numRuns: 50 },
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

const CLAIM_NAME =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * every op is one scheduler step applied whole, so fast-check orders the
 * waiters' file operations exactly; a write after its file was removed lands
 * on the unlinked file, as it would on disk
 */
function scheduledLockFiles(s: fc.Scheduler) {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  const step = () => s.schedule(Promise.resolve());
  const ops: LockFileOps = {
    readState: async (path, ttlMs): Promise<LockFileState> => {
      await step();
      const file = files.get(path);
      if (!file) return { kind: "absent" };
      try {
        const info: unknown = JSON.parse(file.content);
        if (typeof info === "object" && info !== null) {
          return { kind: "readable", info: info as LockFileStateInfo };
        }
      } catch {
        // unreadable
      }
      return {
        kind: "unreadable",
        fresh: Date.now() - file.mtimeMs <= ttlMs,
        mtimeMs: file.mtimeMs,
      };
    },
    createExclusive: async (path): Promise<LockFileHandle | null> => {
      await step();
      if (files.has(path)) return null;
      const file = { content: "", mtimeMs: Date.now() };
      files.set(path, file);
      return {
        write: async (bytes) => {
          await step();
          file.content = new TextDecoder().decode(bytes);
          file.mtimeMs = Date.now();
        },
        close: () => {},
      };
    },
    remove: async (path) => {
      await step();
      if (!files.delete(path)) throw new Deno.errors.NotFound(path);
    },
  };
  return { files, ops };
}

type LockFileStateInfo = Extract<LockFileState, { kind: "readable" }>["info"];

const STALE_FIXTURES = {
  deadPid: JSON.stringify({
    holder: "crashed@elsewhere",
    hostname: "elsewhere",
    pid: 999_999,
    acquiredAt: new Date().toISOString(),
    ttlMs: 300_000,
    nonce: "stale-dead-pid",
  }),
  pastTtl: JSON.stringify({
    holder: "paused@elsewhere",
    hostname: "elsewhere",
    pid: Deno.pid,
    acquiredAt: new Date(Date.now() - 3_600_000).toISOString(),
    ttlMs: 30_000,
    nonce: "stale-past-ttl",
  }),
  unreadable: "",
} as const;

Deno.test("FileLock.tryAcquire: however waiters interleave against one stale lock, at most one holds it and no claim is left", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-property-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.constantFrom(...Object.keys(STALE_FIXTURES) as Array<
          keyof typeof STALE_FIXTURES
        >),
        fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }),
        async (s, fixture, retries) => {
          const { files, ops } = scheduledLockFiles(s);
          const lockPath = join(dir, ".lock");
          files.set(lockPath, {
            content: STALE_FIXTURES[fixture],
            mtimeMs: Date.now() - 3_600_000,
          });
          // long enough that no heartbeat, which bypasses ops, fires in a run
          const waiters = retries.map(() =>
            new FileLock(dir, { lockKey: ".lock", ttlMs: 300_000 }, ops)
          );
          try {
            const won = await s.waitFor(Promise.all(
              waiters.map(async (waiter, index) =>
                await waiter.tryAcquire() ||
                (retries[index] && await waiter.tryAcquire())
              ),
            ));

            const holders = waiters.filter((_, index) => won[index]);
            assert(holders.length <= 1, `${holders.length} holders`);
            if (holders.length === 1) {
              const file = files.get(lockPath);
              assert(file, "the holder's lock file is gone");
              assertEquals(
                JSON.parse(file.content).nonce,
                holders[0].heldNonce,
              );
            }
            const claims = [...files.keys()].filter((path) =>
              CLAIM_NAME.test(path.slice(dir.length + 1))
            );
            assertEquals(claims, []);
          } finally {
            for (const waiter of waiters) await waiter.release();
          }
        },
      ),
      { numRuns: 200 },
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
