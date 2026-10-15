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

import { assertEquals, assertThrows } from "@std/assert";
import {
  fenceKey,
  type FenceRecord,
  heartbeatKey,
  judgeWriterLease,
  parseWriterLeaseKey,
  releasedKey,
  WRITER_FENCED_CODE,
  WRITER_LEASE_CLOCK_SKEW_MS,
  WriterFencedError,
  type WriterLeaseJudgement,
} from "./writer_lease.ts";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const TTL = 30_000;

function record(overrides: Partial<FenceRecord> = {}): FenceRecord {
  return {
    fence: 3,
    holder: "test@host-a",
    hostname: "host-a",
    pid: 100,
    nonce: "nonce-3",
    ttlMs: TTL,
    acquiredAt: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  };
}

function judgement(
  overrides: Partial<WriterLeaseJudgement> = {},
): WriterLeaseJudgement {
  return {
    now: NOW,
    hostname: "host-b",
    processGone: () => false,
    ttlMs: TTL,
    ...overrides,
  };
}

Deno.test("judgeWriterLease: no fence ever taken is free", () => {
  assertEquals(judgeWriterLease({ released: false }, judgement()), {
    kind: "free",
  });
});

Deno.test("judgeWriterLease: a fence renewed within its TTL is held", () => {
  assertEquals(
    judgeWriterLease(
      { fence: 3, record: record(), released: false },
      judgement(),
    ),
    { kind: "held", holderUnknown: false },
  );
});

Deno.test("judgeWriterLease: a released fence is expired, whoever holds it", () => {
  assertEquals(
    judgeWriterLease(
      { fence: 3, record: record(), released: true },
      judgement(),
    ),
    { kind: "expired", reason: "released" },
  );
});

Deno.test("judgeWriterLease: a holder on the judging host whose process is gone is expired at once", () => {
  const gone = judgement({ hostname: "host-a", processGone: () => true });
  assertEquals(
    judgeWriterLease({ fence: 3, record: record(), released: false }, gone),
    { kind: "expired", reason: "process-gone" },
  );
  // Another host's pid means nothing here.
  assertEquals(
    judgeWriterLease(
      { fence: 3, record: record(), released: false },
      judgement({ processGone: () => true }),
    ),
    { kind: "held", holderUnknown: false },
  );
});

Deno.test("judgeWriterLease: expiry is the TTL plus the clock-skew allowance after the last renewal", () => {
  const lastRenewal = NOW - 60_000;
  const records = {
    fence: 3,
    record: record({ acquiredAt: new Date(NOW - 600_000).toISOString() }),
    renewedAt: lastRenewal,
    released: false,
  };
  const at = (now: number) => judgeWriterLease(records, judgement({ now }));
  const expiresAfter = lastRenewal + TTL + WRITER_LEASE_CLOCK_SKEW_MS;
  assertEquals(at(expiresAfter).kind, "held");
  assertEquals(at(expiresAfter + 1), { kind: "expired", reason: "ttl" });
  // A smaller allowance expires it sooner.
  assertEquals(
    judgeWriterLease(
      records,
      judgement({ now: lastRenewal + TTL + 1, clockSkewMs: 0 }),
    ).kind,
    "expired",
  );
});

Deno.test("judgeWriterLease: an unreadable fence record is held only while its heartbeat is fresh", () => {
  // A live holder that has not finished writing its record has renewed.
  assertEquals(
    judgeWriterLease(
      { fence: 3, renewedAt: NOW - 1_000, released: false },
      judgement(),
    ),
    { kind: "held", holderUnknown: true },
  );
  // A holder that crashed mid-write left no heartbeat.
  assertEquals(
    judgeWriterLease({ fence: 3, released: false }, judgement()),
    { kind: "expired", reason: "unreadable" },
  );
  // Or one too old, by the judging writer's TTL plus the allowance.
  assertEquals(
    judgeWriterLease(
      {
        fence: 3,
        renewedAt: NOW - TTL - WRITER_LEASE_CLOCK_SKEW_MS - 1,
        released: false,
      },
      judgement(),
    ),
    { kind: "expired", reason: "unreadable" },
  );
});

Deno.test("fenceKey: keys sort by fence and parse back", () => {
  const keys = [fenceKey(10), fenceKey(9), fenceKey(100)].sort();
  assertEquals(keys, [fenceKey(9), fenceKey(10), fenceKey(100)]);
  assertEquals(parseWriterLeaseKey(fenceKey(9)), { kind: "fence", fence: 9 });
  assertEquals(parseWriterLeaseKey(heartbeatKey(2)), {
    kind: "heartbeat",
    fence: 2,
  });
  assertEquals(parseWriterLeaseKey(releasedKey(4)), {
    kind: "released",
    fence: 4,
  });
  assertEquals(parseWriterLeaseKey("writer/fence-000000000000"), undefined);
  assertEquals(parseWriterLeaseKey("writer/other"), undefined);
  assertEquals(parseWriterLeaseKey("heartbeats/fence-1"), undefined);
});

Deno.test("parseWriterLeaseKey: ignores unpadded and out-of-range keys", () => {
  for (
    const key of [
      "writer/fence-1000000000000",
      "writer/fence-5",
      "writer/heartbeat-5",
      "writer/released-0000000000005",
      "writer/fence-+00000000005",
      "writer/fence-00000000000５",
    ]
  ) {
    assertEquals(parseWriterLeaseKey(key), undefined, key);
  }
  assertEquals(parseWriterLeaseKey("writer/fence-999999999999"), {
    kind: "fence",
    fence: 999_999_999_999,
  });
});

Deno.test("fenceKey: refuses a fence that is not a positive integer", () => {
  for (const fence of [0, -1, 1.5, Number.NaN, 10 ** 12]) {
    assertThrows(() => fenceKey(fence), Error, "writer fence");
  }
});

Deno.test("WriterFencedError: names both fences and carries the fenced code", () => {
  const error = new WriterFencedError(3, 4);
  assertEquals(error.code, WRITER_FENCED_CODE);
  assertEquals(error.code, "datastore_v3_writer_fenced");
  assertEquals(
    error.message.includes("(fence 4) while this one held fence 3"),
    true,
  );
  const released = new WriterFencedError(3, undefined, "released");
  assertEquals(
    released.message.includes("swamp datastore lock release --force"),
    true,
  );
});

Deno.test("WriterFencedError: a replicating writer fenced after publishing says its changes may still appear", () => {
  const published = new WriterFencedError(6, 7, "published");
  assertEquals(published.code, WRITER_FENCED_CODE);
  assertEquals(
    published.message,
    "Another swamp process took over the writer lease of the v3 datastore " +
      "(fence 7) while this one held fence 6, after this command had " +
      "published its changes to the datastore's replica. They may still " +
      "appear: the writer that took over may restore them. Check whether " +
      "they did before running the command again.",
  );
  // Without replication the message is unchanged.
  assertEquals(
    new WriterFencedError(6, 7).message,
    "Another swamp process took over the writer lease of the v3 datastore " +
      "(fence 7) while this one held fence 6. A v3 datastore takes one " +
      "writer at a time, so nothing more from this command was committed. " +
      "Run the command again.",
  );
});
