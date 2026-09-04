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
import { AuditEmitter } from "./audit_emitter.ts";
import type { AuditEvent } from "./audit_event.ts";
import { createAuditEvent } from "./audit_event.ts";
import type { AuditSink } from "./audit_sink.ts";

await initializeLogging({});

function makeEvent(action: string): AuditEvent {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "access",
    resourceName: "*",
    requestId: crypto.randomUUID(),
  });
}

function createMockSink(name: string): AuditSink & {
  written: AuditEvent[][];
  flushed: number;
  closed: boolean;
} {
  const sink = {
    name,
    written: [] as AuditEvent[][],
    flushed: 0,
    closed: false,
    async write(events: readonly AuditEvent[]) {
      sink.written.push([...events]);
    },
    async flush() {
      sink.flushed++;
    },
    async close() {
      sink.closed = true;
    },
  };
  return sink;
}

Deno.test("AuditEmitter: emits events to sinks via drain", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);
  const event = makeEvent("access.check");

  emitter.emit(event);

  await emitter.flush();

  assertEquals(sink.written.length, 1);
  assertEquals(sink.written[0].length, 1);
  assertEquals(sink.written[0][0].action, "access.check");
});

Deno.test("AuditEmitter: batches multiple events in single drain", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);

  emitter.emit(makeEvent("a"));
  emitter.emit(makeEvent("b"));
  emitter.emit(makeEvent("c"));

  await emitter.flush();

  assertEquals(sink.written.length, 1);
  assertEquals(sink.written[0].length, 3);
});

Deno.test("AuditEmitter: fans out to multiple sinks", async () => {
  const sinkA = createMockSink("a");
  const sinkB = createMockSink("b");
  const emitter = new AuditEmitter([sinkA, sinkB]);

  emitter.emit(makeEvent("test"));
  await emitter.flush();

  assertEquals(sinkA.written.length, 1);
  assertEquals(sinkB.written.length, 1);
});

Deno.test("AuditEmitter: sink error does not propagate to caller", async () => {
  const failingSink: AuditSink = {
    name: "failing",
    async write() {
      throw new Error("sink failure");
    },
    async flush() {},
    async close() {},
  };
  const goodSink = createMockSink("good");
  const emitter = new AuditEmitter([failingSink, goodSink]);

  emitter.emit(makeEvent("test"));
  await emitter.flush();

  assertEquals(goodSink.written.length, 1);
});

Deno.test("AuditEmitter: close flushes then closes all sinks", async () => {
  const sink = createMockSink("test");
  const emitter = new AuditEmitter([sink]);

  emitter.emit(makeEvent("test"));
  await emitter.close();

  assertEquals(sink.written.length, 1);
  assertEquals(sink.flushed, 1);
  assertEquals(sink.closed, true);
});
