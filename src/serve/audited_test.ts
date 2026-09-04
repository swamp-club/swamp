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

import { assertEquals, assertRejects } from "@std/assert";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../domain/serve_audit/audit_sink.ts";
import { audited } from "./audited.ts";

await initializeLogging({});

function createCaptureSink(): AuditSink & { events: AuditEvent[] } {
  const sink = {
    name: "capture",
    events: [] as AuditEvent[],
    write(events: readonly AuditEvent[]): Promise<void> {
      sink.events.push(...events);
      return Promise.resolve();
    },
    flush(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return sink;
}

const baseOptions = {
  instanceId: "inst-1",
  category: "execution" as const,
  action: "model.method.run",
  resourceKind: "model",
  resourceName: "my-model",
  principal: { kind: "user" as const, id: "tok-abc" },
  requestId: "req-1",
};

Deno.test("audited: emits success event on handler success", async () => {
  const sink = createCaptureSink();
  const emitter = new AuditEmitter([sink]);

  await audited(Promise.resolve(), { ...baseOptions, emitter });
  await emitter.flush();

  assertEquals(sink.events.length, 1);
  assertEquals(sink.events[0].outcome, "success");
  assertEquals(sink.events[0].action, "model.method.run");
  assertEquals(sink.events[0].principalKind, "user");
  assertEquals(sink.events[0].principalId, "tok-abc");
  assertEquals(sink.events[0].initiatedBy, "user:tok-abc");
});

Deno.test("audited: emits failure event and re-throws on handler error", async () => {
  const sink = createCaptureSink();
  const emitter = new AuditEmitter([sink]);
  const handlerError = new Error("handler failed");

  await assertRejects(
    () => audited(Promise.reject(handlerError), { ...baseOptions, emitter }),
    Error,
    "handler failed",
  );
  await emitter.flush();

  assertEquals(sink.events.length, 1);
  assertEquals(sink.events[0].outcome, "failure");
  assertEquals(sink.events[0].detail, "handler failed");
});

Deno.test("audited: no-op when emitter is undefined", async () => {
  let handlerRan = false;
  await audited(
    (() => {
      handlerRan = true;
      return Promise.resolve();
    })(),
    { ...baseOptions, emitter: undefined },
  );
  assertEquals(handlerRan, true);
});

Deno.test("audited: preserves handler error type", async () => {
  const sink = createCaptureSink();
  const emitter = new AuditEmitter([sink]);

  class CustomError extends Error {
    code = "custom";
  }

  try {
    await audited(
      Promise.reject(new CustomError("custom error")),
      { ...baseOptions, emitter },
    );
  } catch (error) {
    assertEquals(error instanceof CustomError, true);
    assertEquals((error as CustomError).code, "custom");
  }
});

Deno.test("audited: handles null principal", async () => {
  const sink = createCaptureSink();
  const emitter = new AuditEmitter([sink]);

  await audited(Promise.resolve(), {
    ...baseOptions,
    emitter,
    principal: null,
  });
  await emitter.flush();

  assertEquals(sink.events.length, 1);
  assertEquals(sink.events[0].principalKind, "anonymous");
  assertEquals(sink.events[0].principalId, "anonymous");
  assertEquals(sink.events[0].initiatedBy, "ghost");
});

Deno.test("audited: resolves OAuth sub to username in initiatedBy", async () => {
  const sink = createCaptureSink();
  const emitter = new AuditEmitter([sink]);

  await audited(Promise.resolve(), {
    ...baseOptions,
    emitter,
    principal: { kind: "user", id: "abc-123-sub" },
    resolvedUserNames: { "abc-123-sub": "stack72" },
  });
  await emitter.flush();

  assertEquals(sink.events.length, 1);
  assertEquals(sink.events[0].principalKind, "user");
  assertEquals(sink.events[0].principalId, "abc-123-sub");
  assertEquals(sink.events[0].initiatedBy, "user:stack72");
});

Deno.test("audited: falls back to principalToString when no resolved name", async () => {
  const sink = createCaptureSink();
  const emitter = new AuditEmitter([sink]);

  await audited(Promise.resolve(), {
    ...baseOptions,
    emitter,
    principal: { kind: "worker", id: "w1" },
    resolvedUserNames: {},
  });
  await emitter.flush();

  assertEquals(sink.events.length, 1);
  assertEquals(sink.events[0].initiatedBy, "worker:w1");
});
