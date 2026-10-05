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
import { waitFor } from "@swamp-club/swamp-testing";
import { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../../domain/serve_audit/audit_sink.ts";
import { AuditWal } from "../../domain/serve_audit/audit_wal.ts";
import { WalSink } from "./wal_sink.ts";

await initializeLogging({});

function withTempDir(
  fn: (dir: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = await Deno.makeTempDir({ prefix: "wal-sink-test-" });
    try {
      await fn(dir);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  };
}

function makeEvent(action: string): AuditEvent {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

function createMockSink(): AuditSink & {
  written: AuditEvent[][];
  flushed: number;
  closed: boolean;
} {
  const sink = {
    name: "mock-downstream",
    durable: true,
    written: [] as AuditEvent[][],
    flushed: 0,
    closed: false,
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.written.push([...events]);
      return Promise.resolve();
    },
    flush(): Promise<void> {
      sink.flushed++;
      return Promise.resolve();
    },
    close(): Promise<void> {
      sink.closed = true;
      return Promise.resolve();
    },
  };
  return sink;
}

function createFailingSink(): AuditSink & { failWrites: boolean } {
  return {
    name: "failing-downstream",
    durable: true,
    failWrites: true,
    write(): Promise<void> {
      if (this.failWrites) {
        return Promise.reject(new Error("downstream unavailable"));
      }
      return Promise.resolve();
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

Deno.test(
  "WalSink: writes to downstream and WAL, then cleans up on flush",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("test")]);
    assertEquals(wal.segmentCount, 1);

    await sink.flush();
    assertEquals(downstream.written.length, 1);
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: persists to WAL when downstream fails",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createFailingSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("persisted")]);

    assertEquals(wal.segmentCount, 1);
    const events = await wal.readSegment(wal.listSegments()[0]);
    assertEquals(events[0].action, "persisted");
  }),
);

Deno.test(
  "WalSink: WAL segments not deleted when downstream fails",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createFailingSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("keep-me")]);
    await sink.flush();

    assertEquals(wal.segmentCount, 1);
  }),
);

Deno.test(
  "WalSink: replay delivers undelivered WAL segments to downstream",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("orphaned-1")]);
    await wal.append([makeEvent("orphaned-2")]);

    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream });

    const count = await sink.replay();

    assertEquals(count, 2);
    assertEquals(downstream.written.length, 2);
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: replay stops at first failure and retains remaining segments",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("first")]);
    await wal.append([makeEvent("second")]);

    let writeCount = 0;
    const failOnSecond: AuditSink = {
      name: "fail-on-second",
      durable: true,
      write(): Promise<void> {
        writeCount++;
        if (writeCount >= 2) {
          return Promise.reject(new Error("fail on second"));
        }
        return Promise.resolve();
      },
      flush(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
    const sink = new WalSink({ wal, downstream: failOnSecond });

    const count = await sink.replay();

    assertEquals(count, 1);
    assertEquals(wal.segmentCount, 1);
  }),
);

Deno.test(
  "WalSink: replay with no segments returns zero",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream });

    const count = await sink.replay();
    assertEquals(count, 0);
    assertEquals(downstream.written.length, 0);
  }),
);

Deno.test(
  "WalSink: close flushes and closes downstream",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("before-close")]);
    await sink.close();

    assertEquals(downstream.closed, true);
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: multiple writes create multiple WAL segments",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("a")]);
    await sink.write([makeEvent("b")]);
    await sink.write([makeEvent("c")]);

    assertEquals(wal.segmentCount, 3);

    await sink.flush();
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["a", "b", "c"],
    );
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: replay skips empty segments from partial writes",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();

    // Write a valid segment then create an empty one
    await wal.append([makeEvent("valid")]);
    const emptyName = `${Date.now()}-${crypto.randomUUID()}.wal.jsonl`;
    await Deno.writeTextFile(`${dir}/${emptyName}`, "");
    await wal.initialize();

    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream });

    const count = await sink.replay();
    assertEquals(count, 1);
    assertEquals(downstream.written.length, 1);
    assertEquals(wal.segmentCount, 0);
  }),
);

/** A downstream sink whose writes hang until released. */
function createHangingSink(): AuditSink & {
  written: AuditEvent[][];
  outstanding: number;
  maxOutstanding: number;
  release(): void;
} {
  const pending: (() => void)[] = [];
  const sink = {
    name: "hanging-downstream",
    durable: true,
    written: [] as AuditEvent[][],
    outstanding: 0,
    maxOutstanding: 0,
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.outstanding++;
      sink.maxOutstanding = Math.max(sink.maxOutstanding, sink.outstanding);
      return new Promise<void>((resolve) => {
        pending.push(() => {
          sink.outstanding--;
          sink.written.push([...events]);
          resolve();
        });
      });
    },
    release(): void {
      for (const done of pending.splice(0)) done();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return sink;
}

Deno.test(
  "WalSink: write resolves once the WAL has the events, while downstream hangs",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createHangingSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("first")]);
    await sink.write([makeEvent("second")]);
    assertEquals(wal.segmentCount, 2);

    // Deliveries go one at a time, in order, each segment once.
    for (let i = 0; i < 2; i++) {
      await waitFor(() => downstream.outstanding === 1, "a delivery to start");
      downstream.release();
      await waitFor(
        () => downstream.written.length === i + 1,
        "the delivery to land",
      );
    }
    await sink.flush();
    assertEquals(downstream.maxOutstanding, 1);
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["first", "second"],
    );
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: flush stops waiting for a hung downstream and keeps its segments in the WAL",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createHangingSink();
    const sink = new WalSink({ wal, downstream, deliveryWaitMs: 20 });

    await sink.write([makeEvent("stuck")]);
    await sink.flush();
    await sink.flush();
    assertEquals(downstream.written.length, 0);
    assertEquals(wal.segmentCount, 1);

    downstream.release();
    await waitFor(() => downstream.written.length === 1, "late delivery");
    await sink.flush();
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: a segment the WAL size limit dropped before delivery is skipped",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir, maxWalBytes: 1 });
    await wal.initialize();
    const downstream = createHangingSink();
    const sink = new WalSink({ wal, downstream });

    await sink.write([makeEvent("one")]);
    await sink.write([makeEvent("two")]);
    await sink.write([makeEvent("three")]);
    // Only the newest segment is kept; the first was already being delivered.
    assertEquals(wal.segmentCount, 1);

    await waitFor(() => downstream.outstanding === 1, "first delivery");
    downstream.release();
    await waitFor(() => downstream.written.length === 1, "first delivered");
    await waitFor(() => downstream.outstanding === 1, "next delivery");
    downstream.release();
    await waitFor(
      () => downstream.written.length === 2,
      "delivery of the kept segment",
    );
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["one", "three"],
    );
    await sink.close();
  }),
);

Deno.test(
  "WalSink: behind an AuditEmitter, a hung store does not stall the durable path or duplicate events",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createHangingSink();
    const walSink = new WalSink({ wal, downstream, deliveryWaitMs: 20 });
    const emitter = new AuditEmitter({
      sinks: [walSink],
      sinkTimeoutMs: 20,
      durableRetryMs: 1,
    });

    for (const action of ["a", "b", "c"]) {
      emitter.emit(makeEvent(action));
      await emitter.flush();
    }
    assertEquals(emitter.durableStalled, false);
    assertEquals(wal.segmentCount >= 1, true);

    await waitFor(async () => {
      downstream.release();
      await emitter.flush();
      return wal.segmentCount === 0;
    }, "every segment delivered");
    const sequences = downstream.written.flat().map((e) =>
      (e as unknown as { sequence: number }).sequence
    );
    assertEquals(sequences, [1, 2, 3]);
    assert(downstream.maxOutstanding <= 1);
    await emitter.close();
  }),
);

Deno.test(
  "WalSink: delivered segments are removed while running, without a flush",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 10 });

    await sink.write([makeEvent("a")]);
    await sink.write([makeEvent("b")]);
    await waitFor(
      () => wal.segmentCount === 0 && downstream.flushed > 0,
      "the checkpoint to remove delivered segments",
    );
    await sink.close();
  }),
);

Deno.test(
  "WalSink: segments whose store flush failed stay in the WAL past later checkpoints",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    let failNextFlush = true;
    downstream.flush = () => {
      if (failNextFlush) {
        failNextFlush = false;
        return Promise.reject(new Error("batch did not reach the store"));
      }
      return Promise.resolve();
    };
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    await sink.write([makeEvent("unconfirmed")]);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);

    await sink.write([makeEvent("confirmed")]);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);
    const kept = await wal.readSegment(wal.listSegments()[0]);
    assertEquals(kept.map((e) => e.action), ["unconfirmed"]);
    await sink.close();
  }),
);
