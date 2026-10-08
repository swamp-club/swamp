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
import { waitFor } from "@swamp-club/swamp-testing";
import { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import {
  type AuditSink,
  UnconfirmedEventsError,
} from "../../domain/serve_audit/audit_sink.ts";
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";
import { StoreSink } from "./store_sink.ts";
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
  "WalSink: replay delivers undelivered WAL segments and deletes them once a checkpoint confirms them",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([withDigest("orphaned-1", 1)]);
    await wal.append([withDigest("orphaned-2", 2)]);

    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    const count = await sink.replay();
    assertEquals(count, 2);

    await sink.flush();
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["orphaned-1", "orphaned-2"],
    );
    assertEquals(wal.segmentCount, 0);
    // A crash restart after the deletion still resumes the chain from the
    // replayed events.
    const restarted = new AuditWal({ dir });
    await restarted.initialize();
    assertEquals(await restarted.loadChainState(), {
      sequence: 2,
      previousDigest: "d2",
    });
    await sink.close();
  }),
);

Deno.test(
  "WalSink with a StoreSink: replay keeps a previous session's segment until the store confirms it",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([chained("orphaned", 1)]);
    let down = true;
    const stored: number[] = [];
    const store: AuditStore = {
      put(_key: string, data: Uint8Array): Promise<void> {
        if (down) return Promise.reject(new Error("store down"));
        for (const line of new TextDecoder().decode(data).split("\n")) {
          if (line.trim()) {
            stored.push((JSON.parse(line) as { sequence: number }).sequence);
          }
        }
        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
    };
    const storeSink = new StoreSink({
      stores: [store],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });
    const sink = new WalSink({
      wal,
      downstream: storeSink,
      checkpointIntervalMs: 0,
    });

    assertEquals(await sink.replay(), 1);
    assertEquals(wal.segmentCount, 1);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);
    assertEquals(stored, []);

    down = false;
    await sink.flush();
    assertEquals(wal.segmentCount, 0);
    assertEquals(stored, [1]);
    await sink.close();
  }),
);

Deno.test(
  "WalSink: replayed segments are delivered before events written after replay",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("orphaned-1")]);
    await wal.append([makeEvent("orphaned-2")]);

    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    await sink.replay();
    await sink.write([makeEvent("live")]);
    await sink.flush();

    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["orphaned-1", "orphaned-2", "live"],
    );
    assertEquals(wal.segmentCount, 0);
    await sink.close();
  }),
);

Deno.test(
  "WalSink: replay keeps a segment whose delivery fails and delivers it again at the next checkpoint",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("first")]);
    await wal.append([makeEvent("second")]);

    const written: string[] = [];
    let failing = true;
    const failSecond: AuditSink = {
      name: "fail-second",
      durable: true,
      write(events: readonly AuditEvent[]): Promise<void> {
        if (failing && events[0].action === "second") {
          return Promise.reject(new Error("downstream unavailable"));
        }
        written.push(events[0].action);
        return Promise.resolve();
      },
      flush(): Promise<void> {
        return Promise.resolve();
      },
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
    const sink = new WalSink({
      wal,
      downstream: failSecond,
      checkpointIntervalMs: 0,
    });

    assertEquals(await sink.replay(), 2);
    await sink.flush();
    assertEquals(written, ["first"]);
    const kept = await wal.readSegment(wal.listSegments()[0]);
    assertEquals(wal.segmentCount, 1);
    assertEquals(kept.map((e) => e.action), ["second"]);

    failing = false;
    await sink.flush();
    assertEquals(written, ["first", "second"]);
    assertEquals(wal.segmentCount, 0);
    await sink.close();
  }),
);

Deno.test({
  name:
    "WalSink: replay leaves a segment it cannot read in the WAL and queues the rest",
  ignore: Deno.build.os === "windows",
  fn: withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("first")]);
    const unreadable = await wal.append([makeEvent("unreadable")]);
    await wal.append([makeEvent("third")]);
    await Deno.chmod(join(dir, unreadable), 0o000);

    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    try {
      assertEquals(await sink.replay(), 2);
      await sink.flush();
      assertEquals(
        downstream.written.map((batch) => batch[0].action),
        ["first", "third"],
      );
      assertEquals(wal.listSegments(), [unreadable]);
    } finally {
      await Deno.chmod(join(dir, unreadable), 0o644);
    }
    await sink.close();
  }),
});

Deno.test(
  "WalSink: a segment written while replay is reading is delivered once",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("orphaned")]);

    const read = wal.readSegment.bind(wal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    let paused = false;
    wal.readSegment = async (segmentName: string) => {
      if (!paused) {
        paused = true;
        await gate;
      }
      return await read(segmentName);
    };
    const downstream = createMockSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    const replaying = sink.replay();
    await waitFor(() => paused, "replay to start reading");
    await sink.write([makeEvent("live")]);
    release();
    assertEquals(await replaying, 1);
    await sink.flush();

    assertEquals(
      downstream.written.map((batch) => batch[0].action).sort(),
      ["live", "orphaned"],
    );
    assertEquals(wal.segmentCount, 0);
    await sink.close();
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
    await sink.flush();
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
    // The flush may stop waiting before the checkpoint has deleted the
    // segment, so poll for it.
    await sink.flush();
    await waitFor(
      () => wal.segmentCount === 0,
      "the checkpoint to remove the delivered segment",
    );
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
    // "one" is read back and being delivered before the limit drops it.
    await waitFor(() => downstream.outstanding === 1, "first delivery");
    await sink.write([makeEvent("two")]);
    await sink.write([makeEvent("three")]);
    // Only the newest segment is kept.
    assertEquals(wal.segmentCount, 1);

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
  "WalSink: flush checkpoints a segment queued behind a checkpoint that was already waiting",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.append([makeEvent("orphaned")]);
    const downstream = createHangingSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    await sink.replay();
    // The loop is held on the orphaned segment, so the checkpoint replay
    // queued is still waiting when the live segment is queued behind it.
    await waitFor(() => downstream.outstanding === 1, "replay delivery");
    await sink.write([makeEvent("live")]);
    const flushed = sink.flush();

    downstream.release();
    await waitFor(
      () => downstream.written.length === 1 && downstream.outstanding === 1,
      "live delivery",
    );
    downstream.release();
    await flushed;

    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["orphaned", "live"],
    );
    assertEquals(wal.segmentCount, 0);
    await sink.close();
  }),
);

Deno.test(
  "WalSink: pruning the queue under a hung downstream keeps the checkpoint delivered segments wait on",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir, maxWalBytes: 1 });
    await wal.initialize();
    const downstream = createHangingSink();
    let flushes = 0;
    downstream.flush = () => {
      flushes++;
      return Promise.resolve();
    };
    const sink = new WalSink({
      wal,
      downstream,
      deliveryWaitMs: 20,
      checkpointIntervalMs: 0,
    });

    await sink.write([makeEvent("delivered")]);
    await waitFor(() => downstream.outstanding === 1, "first delivery");
    downstream.release();
    await waitFor(() => downstream.written.length === 1, "first delivered");
    await sink.write([makeEvent("hung")]);
    await waitFor(() => downstream.outstanding === 1, "hung delivery");

    // The first flush leaves a checkpoint at the head of the queue. Each
    // later one queues another behind a segment the size limit then drops,
    // which is what the prune collapses.
    await sink.flush();
    for (let i = 0; i < 10; i++) {
      await sink.write([makeEvent(`flushed-${i}`)]);
      await sink.flush();
    }
    // With no flush after these, the only checkpoint ahead of the segment
    // the WAL still holds is the one at the head.
    for (let i = 0; i < 20; i++) {
      await sink.write([makeEvent(`queued-${i}`)]);
    }
    assertEquals(flushes, 0);

    downstream.release();
    await waitFor(
      () => downstream.written.length === 2 && downstream.outstanding === 1,
      "delivery of the kept segment",
    );
    // The head checkpoint ran before the kept segment was sent.
    assertEquals(flushes, 1);

    downstream.release();
    // The flush may stop waiting before the checkpoint has deleted the
    // segments, and close deletes nothing once it gives up, so poll for the
    // checkpoint before closing.
    await sink.flush();
    await waitFor(
      () => wal.segmentCount === 0,
      "the checkpoint to remove the delivered segments",
    );
    await sink.close();
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["delivered", "hung", "queued-19"],
    );
    assertEquals(wal.segmentCount, 0);
  }),
);

Deno.test(
  "WalSink: behind an AuditEmitter, a hung store does not stall the durable path or duplicate events",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createHangingSink();
    const walSink = new WalSink({ wal, downstream, deliveryWaitMs: 20 });
    // A generous timeout: the WAL append is real disk I/O, which a slow
    // Windows runner can take longer than a few milliseconds to finish
    // (swamp-club#3167). A write that waited on the hung store would still
    // never settle within it and leave the durable path stalled.
    const emitter = new AuditEmitter({
      sinks: [walSink],
      sinkTimeoutMs: 10_000,
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
  "WalSink: a segment the store did not confirm is delivered again at the next checkpoint",
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
    assertEquals(wal.segmentCount, 0);
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["unconfirmed", "confirmed", "unconfirmed"],
    );
    await sink.close();
  }),
);

Deno.test(
  "WalSink: a segment whose delivery failed is delivered again at the next checkpoint",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createFailingSink();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    await sink.write([makeEvent("retry-me")]);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);

    downstream.failWrites = false;
    await sink.flush();
    assertEquals(wal.segmentCount, 0);
    await sink.close();
  }),
);

function chained(action: string, sequence: number): AuditEvent {
  return { ...makeEvent(action), sequence } as AuditEvent;
}

Deno.test(
  "WalSink: only the segments whose events the store reports unconfirmed are delivered again",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    let report: ReadonlySet<number> | null | undefined = new Set([2]);
    downstream.flush = () => {
      if (report === undefined) return Promise.resolve();
      const sequences = report;
      report = undefined;
      return Promise.reject(new UnconfirmedEventsError("unstored", sequences));
    };
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    await sink.write([chained("stored", 1)]);
    await sink.write([chained("unstored", 2)]);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);
    const kept = await wal.readSegment(wal.listSegments()[0]);
    assertEquals(kept.map((e) => e.action), ["unstored"]);

    await sink.flush();
    assertEquals(wal.segmentCount, 0);
    assertEquals(
      downstream.written.map((batch) => batch[0].action),
      ["stored", "unstored", "unstored"],
    );
    await sink.close();
  }),
);

Deno.test(
  "WalSink with a StoreSink: a store outage mid-window stores every sequence exactly once",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    let down = false;
    const stored: AuditEvent[] = [];
    const store: AuditStore = {
      put(_key: string, data: Uint8Array): Promise<void> {
        if (down) return Promise.reject(new Error("store down"));
        for (const line of new TextDecoder().decode(data).split("\n")) {
          if (line.trim()) stored.push(JSON.parse(line) as AuditEvent);
        }
        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
    };
    const storeSink = new StoreSink({
      stores: [store],
      batchSize: 1,
      flushIntervalMs: 60_000,
    });
    const sink = new WalSink({
      wal,
      downstream: storeSink,
      checkpointIntervalMs: 0,
    });

    await sink.write([chained("before-outage", 1)]);
    await sink.flush();
    await sink.write([chained("stored-in-window", 2)]);
    await waitFor(() => stored.length === 2, "the batch-size put");
    down = true;
    await sink.write([chained("during-outage", 3)]);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);

    down = false;
    await sink.flush();
    assertEquals(wal.segmentCount, 0);
    assertEquals(
      stored.map((e) => (e as unknown as { sequence: number }).sequence),
      [1, 2, 3],
    );
    await sink.close();
  }),
);

Deno.test(
  "WalSink: once close has given up, a checkpoint still queued deletes nothing",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createHangingSink();
    let flushes = 0;
    downstream.flush = () => {
      flushes++;
      return Promise.resolve();
    };
    const sink = new WalSink({
      wal,
      downstream,
      deliveryWaitMs: 20,
      checkpointIntervalMs: 0,
    });

    await sink.write([makeEvent("delivered")]);
    await waitFor(() => downstream.outstanding === 1, "first delivery");
    downstream.release();
    await waitFor(() => downstream.written.length === 1, "first delivered");
    await sink.write([makeEvent("hung")]);
    await waitFor(() => downstream.outstanding === 1, "hung delivery");

    await sink.close();
    downstream.release();
    await waitFor(() => flushes === 1, "the queued checkpoint to run");
    assertEquals(wal.segmentCount, 2);
  }),
);

Deno.test(
  "WalSink with a StoreSink: a segment whose second date no store took is kept, not resent, until the retry lands",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    let failDate: string | null = "2026-10-07";
    const stored: number[] = [];
    const store: AuditStore = {
      put(key: string, data: Uint8Array): Promise<void> {
        if (failDate !== null && key.includes(failDate)) {
          return Promise.reject(new Error("store down"));
        }
        for (const line of new TextDecoder().decode(data).split("\n")) {
          if (line.trim()) {
            stored.push((JSON.parse(line) as { sequence: number }).sequence);
          }
        }
        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
    };
    const storeSink = new StoreSink({
      stores: [store],
      batchSize: 100,
      flushIntervalMs: 60_000,
    });
    const sink = new WalSink({
      wal,
      downstream: storeSink,
      checkpointIntervalMs: 0,
    });

    await sink.write([
      {
        ...chained("before-midnight", 1),
        timestamp: "2026-10-06T23:59:59.000Z",
      },
      {
        ...chained("after-midnight", 2),
        timestamp: "2026-10-07T00:00:01.000Z",
      },
    ]);
    await sink.flush();
    assertEquals(wal.segmentCount, 1);
    assertEquals(stored, [1]);

    failDate = null;
    await sink.flush();
    assertEquals(wal.segmentCount, 0);
    assertEquals(stored, [1, 2]);
    await sink.close();
  }),
);

function withDigest(action: string, sequence: number): AuditEvent {
  return { ...chained(action, sequence), digest: `d${sequence}` } as AuditEvent;
}

Deno.test(
  "WalSink: a checkpoint records the chain position before deleting, so a crash restart resumes from it",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const sink = new WalSink({
      wal,
      downstream: createMockSink(),
      checkpointIntervalMs: 0,
    });

    await sink.write([withDigest("a", 1), withDigest("b", 2)]);
    await sink.write([withDigest("c", 3)]);
    await sink.flush();
    assertEquals(wal.segmentCount, 0);

    // A process killed now never runs the shutdown save; a restart reads the
    // directory afresh.
    const restarted = new AuditWal({ dir });
    await restarted.initialize();
    assertEquals(restarted.segmentCount, 0);
    assertEquals(await restarted.loadChainState(), {
      sequence: 3,
      previousDigest: "d3",
    });
  }),
);

Deno.test(
  "WalSink: a checkpoint never moves the saved chain position backwards",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    await wal.saveChainState({ sequence: 10, previousDigest: "d10" });
    const sink = new WalSink({
      wal,
      downstream: createMockSink(),
      checkpointIntervalMs: 0,
    });

    await sink.write([withDigest("old", 3)]);
    await sink.flush();
    assertEquals(await wal.loadChainState(), {
      sequence: 10,
      previousDigest: "d10",
    });
    await sink.close();
  }),
);

Deno.test(
  "WalSink: an unexpected flush error does not resend a segment the store said it is still retrying",
  withTempDir(async (dir) => {
    const wal = new AuditWal({ dir });
    await wal.initialize();
    const downstream = createMockSink();
    const flushes: (() => Promise<void>)[] = [
      () =>
        Promise.reject(
          new UnconfirmedEventsError("pending", new Set(), new Set([1])),
        ),
      () => Promise.reject(new TypeError("store client blew up")),
      () => Promise.resolve(),
    ];
    downstream.flush = () => flushes.shift()!();
    const sink = new WalSink({ wal, downstream, checkpointIntervalMs: 0 });

    await sink.write([chained("retried-by-store", 1)]);
    await sink.flush();
    await sink.flush();
    assertEquals(downstream.written.length, 1);
    assertEquals(wal.segmentCount, 1);

    await sink.flush();
    assertEquals(downstream.written.length, 1);
    assertEquals(wal.segmentCount, 0);
    await sink.close();
  }),
);
