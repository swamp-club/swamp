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
    assertEquals(downstream.written.length, 1);
    assertEquals(wal.segmentCount, 1);

    await sink.flush();
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
    assertEquals(downstream.written.length, 3);

    await sink.flush();
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
