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

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  compareTickets,
  DEFAULT_TICKET_TTL_MS,
  defaultTicketTtlMs,
  formatTicketName,
  fsLockQueueOps,
  LOCK_QUEUES_DIR,
  LockQueue,
  lockQueueDir,
  nextSeq,
  overrideTicketTtlForTesting,
  ownHostIdHash,
  parseTicketName,
  ticketLiveness,
  type WaitTicket,
} from "./lock_queue.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-queue-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const NONCE_A = "0".repeat(31) + "a";
const NONCE_B = "0".repeat(31) + "b";

function ticket(overrides: Partial<WaitTicket> = {}): WaitTicket {
  return {
    seq: 1,
    hostIdHash: "0123abcd",
    pid: 4242,
    nonce: NONCE_A,
    ...overrides,
  };
}

Deno.test("formatTicketName: pads the seq and parses back to the same ticket", () => {
  const name = formatTicketName(ticket({ seq: 42 }));
  assertEquals(name, `0000000000000042-0123abcd-4242-${NONCE_A}.ticket`);
  assertEquals(parseTicketName(name), ticket({ seq: 42 }));
});

Deno.test("parseTicketName: refuses names that are not tickets", () => {
  for (
    const name of [
      ".lock",
      "0000000000000001-0123abcd-4242-" + NONCE_A + ".lock",
      "1-0123abcd-4242-" + NONCE_A + ".ticket",
      "0000000000000001-0123ABCD-4242-" + NONCE_A + ".ticket",
      "0000000000000001-0123abcd-x-" + NONCE_A + ".ticket",
      "0000000000000001-0123abcd-4242-short.ticket",
      ".0000000000000001-0123abcd-4242-" + NONCE_A + ".ticket",
    ]
  ) {
    assertEquals(parseTicketName(name), null, name);
  }
});

Deno.test("formatTicketName: a ticket's name never ends in .lock", () => {
  const name = formatTicketName(ticket());
  assertFalse(/\.lock$/.test(name));
  assert(name.endsWith(".ticket"));
});

Deno.test("compareTickets: orders by seq, then by nonce", () => {
  assert(compareTickets(ticket({ seq: 1 }), ticket({ seq: 2 })) < 0);
  assert(
    compareTickets(
      ticket({ seq: 9, nonce: NONCE_A }),
      ticket({ seq: 10, nonce: NONCE_B }),
    ) < 0,
  );
  assert(
    compareTickets(ticket({ nonce: NONCE_B }), ticket({ nonce: NONCE_A })) > 0,
  );
  assertEquals(compareTickets(ticket(), ticket()), 0);
});

Deno.test("nextSeq: 1 for an empty queue, else one past the highest", () => {
  assertEquals(nextSeq([]), 1);
  assertEquals(nextSeq([ticket({ seq: 3 }), ticket({ seq: 7 })]), 8);
});

Deno.test("ticketLiveness: decides by pid on this host and by an unmoved mtime otherwise", () => {
  const gone = (pid: number) => pid === 4242;
  const alive = () => false;
  const ttlMs = 1_000;
  const cases: {
    name: string;
    sameHost: boolean;
    processGone: (pid: number) => boolean;
    mtimeMs: number;
    previous?: { mtimeMs: number; firstSeenMs: number };
    nowMs: number;
    dead: boolean;
    firstSeenMs: number;
  }[] = [
    {
      name: "same host, process gone: dead at first sight",
      sameHost: true,
      processGone: gone,
      mtimeMs: 5,
      nowMs: 100,
      dead: true,
      firstSeenMs: 100,
    },
    {
      name: "same host, pid reused by a live process: live until the TTL",
      sameHost: true,
      processGone: alive,
      mtimeMs: 5,
      previous: { mtimeMs: 5, firstSeenMs: 100 },
      nowMs: 1_099,
      dead: false,
      firstSeenMs: 100,
    },
    {
      name: "same host, pid reused, heartbeat stopped for the TTL: dead",
      sameHost: true,
      processGone: alive,
      mtimeMs: 5,
      previous: { mtimeMs: 5, firstSeenMs: 100 },
      nowMs: 1_100,
      dead: true,
      firstSeenMs: 100,
    },
    {
      name: "another host: its pid is never probed",
      sameHost: false,
      processGone: gone,
      mtimeMs: 5,
      nowMs: 100,
      dead: false,
      firstSeenMs: 100,
    },
    {
      name: "another host, mtime unmoved for the TTL: dead",
      sameHost: false,
      processGone: gone,
      mtimeMs: 5,
      previous: { mtimeMs: 5, firstSeenMs: 100 },
      nowMs: 1_100,
      dead: true,
      firstSeenMs: 100,
    },
    {
      name: "another host, mtime moved: the clock restarts",
      sameHost: false,
      processGone: gone,
      mtimeMs: 6,
      previous: { mtimeMs: 5, firstSeenMs: 100 },
      nowMs: 5_000,
      dead: false,
      firstSeenMs: 5_000,
    },
    {
      name: "an mtime far in the future or past means nothing alone",
      sameHost: false,
      processGone: gone,
      mtimeMs: -1_000_000_000,
      nowMs: 10,
      dead: false,
      firstSeenMs: 10,
    },
  ];
  for (const c of cases) {
    const result = ticketLiveness({
      ticket: ticket(),
      sameHost: c.sameHost,
      processGone: c.processGone,
      mtimeMs: c.mtimeMs,
      previous: c.previous,
      nowMs: c.nowMs,
      ttlMs,
    });
    assertEquals(result.dead, c.dead, c.name);
    assertEquals(result.observation.firstSeenMs, c.firstSeenMs, c.name);
    assertEquals(result.observation.mtimeMs, c.mtimeMs, c.name);
  }
});

Deno.test("lockQueueDir: sits under lock-queues, beside data/, namespaced like the lock", async () => {
  const key = "data/aws-ec2/my-server/.lock";
  const plain = await lockQueueDir("/base", undefined, key);
  const spaced = await lockQueueDir("/base", "ns", key);
  const name = plain.split(/[\\/]/).pop()!;
  assertEquals(plain, join("/base", LOCK_QUEUES_DIR, name));
  assertEquals(spaced, join("/base", "ns", LOCK_QUEUES_DIR, name));
  assert(/^[0-9a-f]{32}$/.test(name));
  assertFalse(
    plain === await lockQueueDir("/base", undefined, "data/a/b/.lock"),
  );
});

Deno.test("overrideTicketTtlForTesting: shortens the default until disposed", () => {
  assertEquals(defaultTicketTtlMs(), DEFAULT_TICKET_TTL_MS);
  {
    using _ttl = overrideTicketTtlForTesting(123);
    assertEquals(defaultTicketTtlMs(), 123);
  }
  assertEquals(defaultTicketTtlMs(), DEFAULT_TICKET_TTL_MS);
});

Deno.test("LockQueue: tickets take seqs in arrival order, the first is head, and the last to leave removes the directory", async () => {
  await withTempDir(async (base) => {
    const dir = join(base, LOCK_QUEUES_DIR, "q");
    const first = new LockQueue(dir);
    const second = new LockQueue(dir);
    assert(await first.isEmpty());
    await first.enqueue();
    await second.enqueue();
    try {
      assertFalse(await first.isEmpty());
      const names = (await fsLockQueueOps.list(dir))!.map((t) => t.name)
        .sort();
      assertEquals(names.map((n) => parseTicketName(n)!.seq), [1, 2]);
      assertEquals(await first.headCheck(), { head: true });
      assertEquals(await second.headCheck(), { head: false, ahead: 1 });
      await first.leave();
      assertEquals(await second.headCheck(), { head: true });
    } finally {
      await first.leave();
      await second.leave();
    }
    assertEquals(await fsLockQueueOps.list(dir), null);
  });
});

Deno.test("LockQueue: a waiter whose ticket was removed queues again at the back", async () => {
  await withTempDir(async (base) => {
    const dir = join(base, LOCK_QUEUES_DIR, "q");
    const first = new LockQueue(dir);
    const second = new LockQueue(dir);
    await first.enqueue();
    await second.enqueue();
    try {
      const [firstName] = (await fsLockQueueOps.list(dir))!.map((t) => t.name)
        .sort();
      await Deno.remove(join(dir, firstName));
      assertEquals(await first.headCheck(), { head: false, ahead: 1 });
      assertEquals(await second.headCheck(), { head: true });
      const seqs = (await fsLockQueueOps.list(dir))!.map((t) =>
        parseTicketName(t.name)!.seq
      ).sort();
      assertEquals(seqs, [2, 3]);
    } finally {
      await first.leave();
      await second.leave();
    }
  });
});

Deno.test("LockQueue: a dead ticket ahead is removed; a live one on another host waits for the TTL of the observer's clock", async () => {
  await withTempDir(async (base) => {
    const dir = join(base, LOCK_QUEUES_DIR, "q");
    await Deno.mkdir(dir, { recursive: true });
    const own = await ownHostIdHash();
    const foreign = own === "ffffffff" ? "eeeeeeee" : "ffffffff";
    const deadHere = formatTicketName(
      ticket({ seq: 1, hostIdHash: own, pid: 999_999 }),
    );
    const elsewhere = formatTicketName(
      ticket({ seq: 2, hostIdHash: foreign, pid: 999_999 }),
    );
    await Deno.writeTextFile(join(dir, deadHere), "");
    await Deno.writeTextFile(join(dir, elsewhere), "");
    let nowMs = 0;
    const queue = new LockQueue(
      dir,
      1_000,
      { ...fsLockQueueOps, processGone: (pid) => pid === 999_999 },
      () => nowMs,
    );
    await queue.enqueue();
    try {
      assertEquals(await queue.headCheck(), { head: false, ahead: 1 });
      const left = (await fsLockQueueOps.list(dir))!.map((t) => t.name);
      assertFalse(left.includes(deadHere));
      nowMs = 999;
      assertEquals(await queue.headCheck(), { head: false, ahead: 1 });
      nowMs = 1_000;
      assertEquals(await queue.headCheck(), { head: true });
      assertFalse(
        (await fsLockQueueOps.list(dir))!.some((t) => t.name === elsewhere),
      );
    } finally {
      await queue.leave();
    }
  });
});

Deno.test("LockQueue: enqueue retries when the directory vanishes before the ticket is created", async () => {
  await withTempDir(async (base) => {
    const dir = join(base, LOCK_QUEUES_DIR, "q");
    let vanish = true;
    const queue = new LockQueue(dir, DEFAULT_TICKET_TTL_MS, {
      ...fsLockQueueOps,
      createExclusive: async (path) => {
        if (vanish) {
          vanish = false;
          await Deno.remove(dir);
        }
        return await fsLockQueueOps.createExclusive(path);
      },
    });
    await queue.enqueue();
    try {
      assertEquals((await fsLockQueueOps.list(dir))!.length, 1);
    } finally {
      await queue.leave();
    }
  });
});

Deno.test("LockQueue: the heartbeat moves the ticket's mtime forward each beat", async () => {
  await withTempDir(async (base) => {
    const dir = join(base, LOCK_QUEUES_DIR, "q");
    const touched: number[] = [];
    const queue = new LockQueue(dir, 30, {
      ...fsLockQueueOps,
      touch: async (path, mtime) => {
        touched.push(mtime.getTime());
        await fsLockQueueOps.touch(path, mtime);
      },
    });
    await queue.enqueue();
    try {
      await waitFor(() => touched.length >= 3, "three heartbeats");
    } finally {
      await queue.leave();
    }
    for (let i = 1; i < touched.length; i++) {
      assert(touched[i] - touched[i - 1] >= 1_000, `beat ${i} moved forward`);
    }
  });
});
