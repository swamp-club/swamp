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
import type { SerializedEvent } from "./protocol.ts";
import {
  type BufferTerminal,
  RunEventBuffer,
  type RunEventSubscriber,
} from "./run_event_buffer.ts";

function event(kind: string): SerializedEvent {
  return { kind };
}

function collectingSubscriber(): {
  subscriber: RunEventSubscriber;
  events: Array<{ seq: number; event: SerializedEvent }>;
  terminals: BufferTerminal[];
  detachCount: number;
} {
  const events: Array<{ seq: number; event: SerializedEvent }> = [];
  const terminals: BufferTerminal[] = [];
  const state = { detachCount: 0 };
  return {
    events,
    terminals,
    get detachCount() {
      return state.detachCount;
    },
    subscriber: {
      onEvent(seq, ev) {
        events.push({ seq, event: ev });
      },
      onTerminal(t) {
        terminals.push(t);
      },
      onDetach() {
        state.detachCount++;
      },
    },
  };
}

Deno.test("RunEventBuffer: push increments seq monotonically", () => {
  const buf = new RunEventBuffer(100);
  assertEquals(buf.push(event("a")), 1);
  assertEquals(buf.push(event("b")), 2);
  assertEquals(buf.push(event("c")), 3);
  assertEquals(buf.highSeq, 3);
  assertEquals(buf.length, 3);
});

Deno.test("RunEventBuffer: live subscriber receives events as they are pushed", () => {
  const buf = new RunEventBuffer(100);
  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);

  buf.push(event("a"));
  buf.push(event("b"));

  assertEquals(col.events.length, 2);
  assertEquals(col.events[0].seq, 1);
  assertEquals(col.events[0].event.kind, "a");
  assertEquals(col.events[1].seq, 2);
  assertEquals(col.events[1].event.kind, "b");
});

Deno.test("RunEventBuffer: subscriber receives terminal on finish", () => {
  const buf = new RunEventBuffer(100);
  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);

  buf.push(event("a"));
  buf.finish({ kind: "done" });

  assertEquals(col.terminals.length, 1);
  assertEquals(col.terminals[0].kind, "done");
  assertEquals(col.detachCount, 1);
});

Deno.test("RunEventBuffer: subscribe with afterSeq replays from afterSeq+1", () => {
  const buf = new RunEventBuffer(100);
  buf.push(event("a"));
  buf.push(event("b"));
  buf.push(event("c"));

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber, 2);

  assertEquals(col.events.length, 1);
  assertEquals(col.events[0].seq, 3);
  assertEquals(col.events[0].event.kind, "c");
});

Deno.test("RunEventBuffer: subscribe with afterSeq=0 replays all", () => {
  const buf = new RunEventBuffer(100);
  buf.push(event("a"));
  buf.push(event("b"));

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber, 0);

  assertEquals(col.events.length, 2);
  assertEquals(col.events[0].seq, 1);
  assertEquals(col.events[1].seq, 2);
});

Deno.test("RunEventBuffer: subscribe after finish replays + terminal synchronously", () => {
  const buf = new RunEventBuffer(100);
  buf.push(event("a"));
  buf.push(event("b"));
  buf.finish({ kind: "done" });

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);

  assertEquals(col.events.length, 2);
  assertEquals(col.terminals.length, 1);
  assertEquals(col.detachCount, 1);
});

Deno.test("RunEventBuffer: subscribe after finish with afterSeq", () => {
  const buf = new RunEventBuffer(100);
  buf.push(event("a"));
  buf.push(event("b"));
  buf.push(event("c"));
  buf.finish({ kind: "error", code: "failed", message: "oops" });

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber, 2);

  assertEquals(col.events.length, 1);
  assertEquals(col.events[0].seq, 3);
  assertEquals(col.terminals.length, 1);
  assertEquals(col.terminals[0].kind, "error");
});

Deno.test("RunEventBuffer: eviction drops oldest events when capacity exceeded", () => {
  const buf = new RunEventBuffer(3);
  buf.push(event("a"));
  buf.push(event("b"));
  buf.push(event("c"));
  buf.push(event("d"));

  assertEquals(buf.length, 3);
  assertEquals(buf.firstSeq, 2);
  assertEquals(buf.highSeq, 4);

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);

  assertEquals(col.events.length, 3);
  assertEquals(col.events[0].event.kind, "b");
  assertEquals(col.events[1].event.kind, "c");
  assertEquals(col.events[2].event.kind, "d");
});

Deno.test("RunEventBuffer: push after finish throws", () => {
  const buf = new RunEventBuffer(100);
  buf.finish({ kind: "done" });

  assertThrows(
    () => buf.push(event("a")),
    Error,
    "Cannot push to a finished RunEventBuffer",
  );
});

Deno.test("RunEventBuffer: finish after finish throws", () => {
  const buf = new RunEventBuffer(100);
  buf.finish({ kind: "done" });

  assertThrows(
    () => buf.finish({ kind: "done" }),
    Error,
    "RunEventBuffer is already finished",
  );
});

Deno.test("RunEventBuffer: multiple subscribers receive the same events", () => {
  const buf = new RunEventBuffer(100);
  const col1 = collectingSubscriber();
  const col2 = collectingSubscriber();
  buf.subscribe(col1.subscriber);
  buf.subscribe(col2.subscriber);

  buf.push(event("a"));
  buf.push(event("b"));
  buf.finish({ kind: "done" });

  assertEquals(col1.events.length, 2);
  assertEquals(col2.events.length, 2);
  assertEquals(col1.terminals.length, 1);
  assertEquals(col2.terminals.length, 1);
});

Deno.test("RunEventBuffer: unsubscribe stops delivery", () => {
  const buf = new RunEventBuffer(100);
  const col = collectingSubscriber();
  const unsub = buf.subscribe(col.subscriber);

  buf.push(event("a"));
  unsub();
  buf.push(event("b"));

  assertEquals(col.events.length, 1);
  assertEquals(col.events[0].event.kind, "a");
  assertEquals(col.detachCount, 1);
});

Deno.test("RunEventBuffer: unsubscribe is idempotent", () => {
  const buf = new RunEventBuffer(100);
  const col = collectingSubscriber();
  const unsub = buf.subscribe(col.subscriber);

  unsub();
  unsub();

  assertEquals(col.detachCount, 1);
});

Deno.test("RunEventBuffer: subscriber joining mid-stream gets replay + live", () => {
  const buf = new RunEventBuffer(100);
  buf.push(event("a"));
  buf.push(event("b"));

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);

  buf.push(event("c"));
  buf.finish({ kind: "done" });

  assertEquals(col.events.length, 3);
  assertEquals(col.events[0].event.kind, "a");
  assertEquals(col.events[1].event.kind, "b");
  assertEquals(col.events[2].event.kind, "c");
  assertEquals(col.terminals.length, 1);
});

Deno.test("RunEventBuffer: subscribe after finish returns no-op unsubscribe", () => {
  const buf = new RunEventBuffer(100);
  buf.finish({ kind: "done" });

  const col = collectingSubscriber();
  const unsub = buf.subscribe(col.subscriber);

  unsub();
  assertEquals(col.detachCount, 1);
});

Deno.test("RunEventBuffer: capacity of 1 works correctly", () => {
  const buf = new RunEventBuffer(1);
  buf.push(event("a"));
  buf.push(event("b"));
  buf.push(event("c"));

  assertEquals(buf.length, 1);
  assertEquals(buf.firstSeq, 3);
  assertEquals(buf.highSeq, 3);

  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);
  assertEquals(col.events.length, 1);
  assertEquals(col.events[0].event.kind, "c");
});

Deno.test("RunEventBuffer: constructor rejects capacity < 1", () => {
  assertThrows(
    () => new RunEventBuffer(0),
    Error,
    "capacity must be at least 1",
  );
});

Deno.test("RunEventBuffer: error terminal carries code and message", () => {
  const buf = new RunEventBuffer(100);
  const col = collectingSubscriber();
  buf.subscribe(col.subscriber);

  buf.finish({ kind: "error", code: "cancelled", message: "User cancelled" });

  assertEquals(col.terminals.length, 1);
  const t = col.terminals[0];
  assertEquals(t.kind, "error");
  if (t.kind === "error") {
    assertEquals(t.code, "cancelled");
    assertEquals(t.message, "User cancelled");
  }
});
