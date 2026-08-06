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
  type ActiveRun,
  ActiveRunRegistry,
  RegistryCapacityError,
  type RunKind,
} from "./active_run_registry.ts";
import { RunEventBuffer } from "./run_event_buffer.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeRun(
  runId: string,
  opts?: {
    completion?: Promise<void>;
    principalId?: string | null;
    kind?: RunKind;
  },
): ActiveRun {
  return {
    runId,
    kind: opts?.kind ?? "workflow-run",
    resourceName: "test-workflow",
    buffer: new RunEventBuffer(100),
    controller: new AbortController(),
    startedAt: new Date(),
    completion: opts?.completion ?? Promise.resolve(),
    principalId: opts?.principalId ?? null,
  };
}

Deno.test("ActiveRunRegistry: register and get", () => {
  const reg = new ActiveRunRegistry();
  const run = makeRun("r1");
  reg.register(run);

  assertEquals(reg.get("r1"), run);
  assertEquals(reg.size, 1);
});

Deno.test("ActiveRunRegistry: get returns undefined for unknown id", () => {
  const reg = new ActiveRunRegistry();
  assertEquals(reg.get("unknown"), undefined);
});

Deno.test("ActiveRunRegistry: register duplicate throws", () => {
  const reg = new ActiveRunRegistry();
  reg.register(makeRun("r1"));

  assertThrows(
    () => reg.register(makeRun("r1")),
    Error,
    "already registered",
  );
});

Deno.test("ActiveRunRegistry: deregister removes the run", () => {
  const reg = new ActiveRunRegistry();
  reg.register(makeRun("r1"));
  reg.deregister("r1");

  assertEquals(reg.get("r1"), undefined);
  assertEquals(reg.size, 0);
});

Deno.test("ActiveRunRegistry: deregister is idempotent", () => {
  const reg = new ActiveRunRegistry();
  reg.register(makeRun("r1"));
  reg.deregister("r1");
  reg.deregister("r1");

  assertEquals(reg.size, 0);
});

Deno.test("ActiveRunRegistry: cancel aborts controller and returns true", () => {
  const reg = new ActiveRunRegistry();
  const run = makeRun("r1");
  reg.register(run);

  assertEquals(reg.cancel("r1"), true);
  assertEquals(run.controller.signal.aborted, true);
});

Deno.test("ActiveRunRegistry: cancel returns false for unknown id", () => {
  const reg = new ActiveRunRegistry();
  assertEquals(reg.cancel("unknown"), false);
});

Deno.test("ActiveRunRegistry: list returns all runs", () => {
  const reg = new ActiveRunRegistry();
  const r1 = makeRun("r1");
  const r2 = makeRun("r2");
  reg.register(r1);
  reg.register(r2);

  const listed = reg.list();
  assertEquals(listed.length, 2);
  assertEquals(listed.map((r) => r.runId).sort(), ["r1", "r2"]);
});

Deno.test("ActiveRunRegistry: drainAll resolves when all completions resolve", async () => {
  const reg = new ActiveRunRegistry();
  const d1 = deferred();
  const d2 = deferred();
  reg.register(makeRun("r1", { completion: d1.promise }));
  reg.register(makeRun("r2", { completion: d2.promise }));

  let drained = false;
  const drainPromise = reg.drainAll(5_000).then(() => {
    drained = true;
  });

  assertEquals(drained, false);

  d1.resolve();
  d2.resolve();
  await drainPromise;

  assertEquals(drained, true);
});

Deno.test("ActiveRunRegistry: drainAll resolves on timeout even if runs are stuck", async () => {
  const reg = new ActiveRunRegistry();
  const neverResolves = new Promise<void>(() => {});
  reg.register(makeRun("stuck", { completion: neverResolves }));

  const start = Date.now();
  await reg.drainAll(100);
  const elapsed = Date.now() - start;

  assertEquals(elapsed >= 90, true);
  assertEquals(elapsed < 1000, true);
});

Deno.test("ActiveRunRegistry: drainAll with empty registry resolves immediately", async () => {
  const reg = new ActiveRunRegistry();
  await reg.drainAll(5_000);
});

Deno.test("ActiveRunRegistry: size tracks registrations and deregistrations", () => {
  const reg = new ActiveRunRegistry();
  assertEquals(reg.size, 0);

  reg.register(makeRun("r1"));
  assertEquals(reg.size, 1);

  reg.register(makeRun("r2"));
  assertEquals(reg.size, 2);

  reg.deregister("r1");
  assertEquals(reg.size, 1);

  reg.deregister("r2");
  assertEquals(reg.size, 0);
});

Deno.test("ActiveRunRegistry: rekey moves entry to new id", () => {
  const reg = new ActiveRunRegistry();
  reg.register(makeRun("r1"));

  assertEquals(reg.rekey("r1", "r2"), true);
  assertEquals(reg.get("r1"), undefined);
  assertEquals(reg.get("r2")?.runId, "r2");
  assertEquals(reg.size, 1);
});

Deno.test("ActiveRunRegistry: rekey returns false for unknown old id", () => {
  const reg = new ActiveRunRegistry();
  assertEquals(reg.rekey("unknown", "r2"), false);
});

Deno.test("ActiveRunRegistry: rekey returns false if new id already exists", () => {
  const reg = new ActiveRunRegistry();
  reg.register(makeRun("r1"));
  reg.register(makeRun("r2"));

  assertEquals(reg.rekey("r1", "r2"), false);
  assertEquals(reg.get("r1")?.runId, "r1");
  assertEquals(reg.get("r2")?.runId, "r2");
});

Deno.test("ActiveRunRegistry: rejects registration when at capacity", () => {
  const reg = new ActiveRunRegistry({ maxConcurrent: 2 });
  reg.register(makeRun("r1"));
  reg.register(makeRun("r2"));

  assertThrows(
    () => reg.register(makeRun("r3")),
    Error,
    "Too many concurrent runs",
  );
});

Deno.test("ActiveRunRegistry: allows registration after deregister frees a slot", () => {
  const reg = new ActiveRunRegistry({ maxConcurrent: 1 });
  reg.register(makeRun("r1"));

  assertThrows(() => reg.register(makeRun("r2")), Error);

  reg.deregister("r1");
  reg.register(makeRun("r2"));
  assertEquals(reg.size, 1);
});

// ── Per-principal accounting ────────────────────────────────────────────

Deno.test("ActiveRunRegistry: per-principal limit rejects when one principal fills their quota", () => {
  const reg = new ActiveRunRegistry({ maxPerPrincipal: 2 });
  reg.register(makeRun("r1", { principalId: "user:alice" }));
  reg.register(makeRun("r2", { principalId: "user:alice" }));

  assertThrows(
    () => reg.register(makeRun("r3", { principalId: "user:alice" })),
    Error,
    "Too many concurrent runs for principal user:alice",
  );
});

Deno.test("ActiveRunRegistry: per-principal limit allows different principals", () => {
  const reg = new ActiveRunRegistry({ maxPerPrincipal: 1 });
  reg.register(makeRun("r1", { principalId: "user:alice" }));
  reg.register(makeRun("r2", { principalId: "user:bob" }));

  assertEquals(reg.size, 2);
});

Deno.test("ActiveRunRegistry: per-principal limit applies to null principal as @anonymous", () => {
  const reg = new ActiveRunRegistry({ maxPerPrincipal: 1 });
  reg.register(makeRun("r1", { principalId: null }));

  assertThrows(
    () => reg.register(makeRun("r2", { principalId: null })),
    Error,
    "Too many concurrent runs for principal @anonymous",
  );
});

Deno.test("ActiveRunRegistry: per-principal slot released on deregister", () => {
  const reg = new ActiveRunRegistry({ maxPerPrincipal: 1 });
  reg.register(makeRun("r1", { principalId: "user:alice" }));

  assertThrows(
    () => reg.register(makeRun("r2", { principalId: "user:alice" })),
    Error,
  );

  reg.deregister("r1");
  reg.register(makeRun("r2", { principalId: "user:alice" }));
  assertEquals(reg.size, 1);
});

Deno.test("ActiveRunRegistry: global cap still enforced alongside per-principal", () => {
  const reg = new ActiveRunRegistry({
    maxConcurrent: 2,
    maxPerPrincipal: 5,
  });
  reg.register(makeRun("r1", { principalId: "user:alice" }));
  reg.register(makeRun("r2", { principalId: "user:bob" }));

  assertThrows(
    () => reg.register(makeRun("r3", { principalId: "user:charlie" })),
    Error,
    "Too many concurrent runs (limit: 2)",
  );
});

// ── Typed error classification ──────────────────────────────────────────

Deno.test("ActiveRunRegistry: duplicate registration throws already_registered", () => {
  const reg = new ActiveRunRegistry();
  reg.register(makeRun("r1"));

  try {
    reg.register(makeRun("r1"));
    throw new Error("should have thrown");
  } catch (err) {
    assertEquals(err instanceof RegistryCapacityError, true);
    assertEquals((err as RegistryCapacityError).code, "already_registered");
  }
});

Deno.test("ActiveRunRegistry: global cap throws global_cap", () => {
  const reg = new ActiveRunRegistry({ maxConcurrent: 1 });
  reg.register(makeRun("r1"));

  try {
    reg.register(makeRun("r2"));
    throw new Error("should have thrown");
  } catch (err) {
    assertEquals(err instanceof RegistryCapacityError, true);
    assertEquals((err as RegistryCapacityError).code, "global_cap");
  }
});

Deno.test("ActiveRunRegistry: per-principal cap throws principal_cap", () => {
  const reg = new ActiveRunRegistry({ maxPerPrincipal: 1 });
  reg.register(makeRun("r1", { principalId: "user:alice" }));

  try {
    reg.register(makeRun("r2", { principalId: "user:alice" }));
    throw new Error("should have thrown");
  } catch (err) {
    assertEquals(err instanceof RegistryCapacityError, true);
    assertEquals((err as RegistryCapacityError).code, "principal_cap");
  }
});

// ── cancelAll ───────────────────────────────────────────────────────────

Deno.test("ActiveRunRegistry: cancelAll aborts all runs", () => {
  const reg = new ActiveRunRegistry();
  const r1 = makeRun("r1", { kind: "workflow-run" });
  const r2 = makeRun("r2", { kind: "method-run" });
  reg.register(r1);
  reg.register(r2);

  const count = reg.cancelAll();
  assertEquals(count, 2);
  assertEquals(r1.controller.signal.aborted, true);
  assertEquals(r2.controller.signal.aborted, true);
});

Deno.test("ActiveRunRegistry: cancelAll with type filter", () => {
  const reg = new ActiveRunRegistry();
  const r1 = makeRun("r1", { kind: "workflow-run" });
  const r2 = makeRun("r2", { kind: "method-run" });
  reg.register(r1);
  reg.register(r2);

  const count = reg.cancelAll("method-run");
  assertEquals(count, 1);
  assertEquals(r1.controller.signal.aborted, false);
  assertEquals(r2.controller.signal.aborted, true);
});

Deno.test("ActiveRunRegistry: cancelAll workflow-run filter includes workflow-resume", () => {
  const reg = new ActiveRunRegistry();
  const r1 = makeRun("r1", { kind: "workflow-run" });
  const r2 = makeRun("r2", { kind: "workflow-resume" });
  const r3 = makeRun("r3", { kind: "method-run" });
  reg.register(r1);
  reg.register(r2);
  reg.register(r3);

  const count = reg.cancelAll("workflow-run");
  assertEquals(count, 2);
  assertEquals(r1.controller.signal.aborted, true);
  assertEquals(r2.controller.signal.aborted, true);
  assertEquals(r3.controller.signal.aborted, false);
});

Deno.test("ActiveRunRegistry: cancelAll returns zero for empty registry", () => {
  const reg = new ActiveRunRegistry();
  assertEquals(reg.cancelAll(), 0);
});

// ── Max run duration ────────────────────────────────────────────────────

Deno.test("ActiveRunRegistry: max duration aborts run after timeout", async () => {
  const reg = new ActiveRunRegistry({ maxRunDurationMs: 100 });
  const d = deferred();
  const run = makeRun("r1", { completion: d.promise });
  reg.register(run);

  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  assertEquals(run.controller.signal.aborted, true);
  d.resolve();
  reg.deregister("r1");
});

Deno.test("ActiveRunRegistry: max duration timer cleared on deregister", async () => {
  const reg = new ActiveRunRegistry({ maxRunDurationMs: 100 });
  const d = deferred();
  const run = makeRun("r1", { completion: d.promise });
  reg.register(run);
  reg.deregister("r1");

  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  assertEquals(run.controller.signal.aborted, false);
  d.resolve();
});

Deno.test("ActiveRunRegistry: max duration timer rekeyed with run", async () => {
  const reg = new ActiveRunRegistry({ maxRunDurationMs: 200 });
  const d = deferred();
  const run = makeRun("r1", { completion: d.promise });
  reg.register(run);
  reg.rekey("r1", "r2");

  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  assertEquals(run.controller.signal.aborted, true);
  d.resolve();
  reg.deregister("r2");
});

// ── Deferred completion pattern ─────────────────────────────────────────

Deno.test("ActiveRunRegistry: completion settles and drainAll returns even when cleanup throws", async () => {
  const reg = new ActiveRunRegistry();

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  const run: ActiveRun = {
    runId: "r1",
    kind: "workflow-resume",
    resourceName: "wf",
    buffer: new RunEventBuffer(100),
    controller: new AbortController(),
    startedAt: new Date(),
    completion,
    principalId: null,
  };
  reg.register(run);

  const throwingDispose = () => {
    throw new Error("simulated dispose failure");
  };

  (async () => {
    try {
      await Promise.reject(new Error("simulated work failure"));
    } finally {
      try {
        throwingDispose();
      } catch { /* swallow like the handler does */ }
      reg.deregister("r1");
      resolveCompletion();
    }
  })().catch(() => {});

  const start = Date.now();
  await reg.drainAll(5_000);
  const elapsed = Date.now() - start;

  assertEquals(reg.size, 0);
  assertEquals(elapsed < 1000, true);
});

Deno.test("ActiveRunRegistry: drainAll blocks when completion never settles", async () => {
  const reg = new ActiveRunRegistry();
  const neverSettles = new Promise<void>(() => {});
  reg.register(makeRun("stuck", { completion: neverSettles }));

  const start = Date.now();
  await reg.drainAll(100);
  const elapsed = Date.now() - start;

  assertEquals(elapsed >= 90, true);
  assertEquals(elapsed < 500, true);
});

// ── Handler-pattern integration tests ───────────────────────────────────
// These simulate the exact deferred-promise pattern used in the three
// handler sites to prove the properties at the wiring level.

Deno.test("handler pattern: rejected registration never starts work", () => {
  const reg = new ActiveRunRegistry({ maxConcurrent: 1 });
  reg.register(makeRun("r1"));

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  let workStarted = false;
  try {
    reg.register({
      runId: "r2",
      kind: "method-run",
      resourceName: "m",
      buffer: new RunEventBuffer(100),
      controller: new AbortController(),
      startedAt: new Date(),
      completion,
      principalId: "user:alice",
    });
  } catch (err) {
    assertEquals(err instanceof RegistryCapacityError, true);
    resolveCompletion();
    // Work IIFE would start here in the handler — but we returned early
    assertEquals(workStarted, false);
    return;
  }

  // If we get here, registration should have failed
  workStarted = true;
  resolveCompletion();
  throw new Error("registration should have been rejected");
});

Deno.test("handler pattern: successful registration produces events through buffer", async () => {
  const reg = new ActiveRunRegistry();
  const buffer = new RunEventBuffer(100);

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  const controller = new AbortController();
  reg.register({
    runId: "r1",
    kind: "workflow-run",
    resourceName: "wf",
    buffer,
    controller,
    startedAt: new Date(),
    completion,
    principalId: "user:alice",
  });

  // Simulate work IIFE
  (async () => {
    try {
      await Promise.resolve();
      buffer.push({ kind: "started", runId: "r1" });
      buffer.push({ kind: "completed", status: "succeeded" });
      buffer.finish({ kind: "done" });
    } finally {
      reg.deregister("r1");
      resolveCompletion();
    }
  })().catch(() => {});

  // Simulate subscribeUntilDetach — read events via callback subscriber
  const events: Array<Record<string, unknown>> = [];
  const { promise: subscribeDone, resolve: subscribeDoneResolve } = deferred();
  buffer.subscribe({
    onEvent: (_seq, event) => {
      events.push(event);
    },
    onTerminal: (terminal) => {
      events.push(terminal);
    },
    onDetach: () => {
      subscribeDoneResolve();
    },
  });

  await subscribeDone;
  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "started");
  assertEquals(events[1].kind, "completed");
  assertEquals(events[2].kind, "done");

  await reg.drainAll(1_000);
  assertEquals(reg.size, 0);
});

Deno.test("handler pattern: completion settles on every exit path", async () => {
  const reg = new ActiveRunRegistry();

  const failWith = (msg: string) => {
    throw new Error(msg);
  };

  // Path 1: normal completion
  {
    let resolve!: () => void;
    const completion = new Promise<void>((r) => {
      resolve = r;
    });
    reg.register({
      ...makeRun("p1"),
      completion,
    });
    (async () => {
      try {
        await Promise.resolve();
      } finally {
        reg.deregister("p1");
        resolve();
      }
    })().catch(() => {});
  }

  // Path 2: work throws
  {
    let resolve!: () => void;
    const completion = new Promise<void>((r) => {
      resolve = r;
    });
    reg.register({
      ...makeRun("p2"),
      completion,
    });
    (async () => {
      try {
        await Promise.reject(new Error("work failed"));
      } finally {
        reg.deregister("p2");
        resolve();
      }
    })().catch(() => {});
  }

  // Path 3: cleanup throws before deregister
  {
    let resolve!: () => void;
    const completion = new Promise<void>((r) => {
      resolve = r;
    });
    reg.register({
      ...makeRun("p3"),
      completion,
    });
    (async () => {
      try {
        await Promise.reject(new Error("work failed"));
      } finally {
        try {
          failWith("dispose failed");
        } catch { /* swallow */ }
        reg.deregister("p3");
        try {
          failWith("deleteActiveRun failed");
        } catch { /* swallow */ }
        resolve();
      }
    })().catch(() => {});
  }

  // Path 4: abort signal
  {
    let resolve!: () => void;
    const completion = new Promise<void>((r) => {
      resolve = r;
    });
    const controller = new AbortController();
    reg.register({
      ...makeRun("p4"),
      controller,
      completion,
    });
    controller.abort(new Error("cancelled"));
    (async () => {
      try {
        await Promise.resolve();
        if (controller.signal.aborted) throw controller.signal.reason;
      } finally {
        reg.deregister("p4");
        resolve();
      }
    })().catch(() => {});
  }

  // All four should settle immediately
  const start = Date.now();
  await reg.drainAll(5_000);
  const elapsed = Date.now() - start;

  assertEquals(reg.size, 0);
  assertEquals(elapsed < 500, true);
});

Deno.test("handler pattern: concurrent duplicate resume — winner survives", () => {
  const reg = new ActiveRunRegistry();
  const buffer1 = new RunEventBuffer(100);
  const buffer2 = new RunEventBuffer(100);
  const controller1 = new AbortController();
  const controller2 = new AbortController();

  let resolve1!: () => void;
  const completion1 = new Promise<void>((r) => {
    resolve1 = r;
  });
  let resolve2!: () => void;
  const completion2 = new Promise<void>((r) => {
    resolve2 = r;
  });

  // First resume registers successfully
  reg.register({
    runId: "resume-123",
    kind: "workflow-resume",
    resourceName: "wf",
    buffer: buffer1,
    controller: controller1,
    startedAt: new Date(),
    completion: completion1,
    principalId: "user:alice",
  });

  // Second resume with same ID fails
  try {
    reg.register({
      runId: "resume-123",
      kind: "workflow-resume",
      resourceName: "wf",
      buffer: buffer2,
      controller: controller2,
      startedAt: new Date(),
      completion: completion2,
      principalId: "user:bob",
    });
    throw new Error("should have thrown");
  } catch (err) {
    assertEquals(err instanceof RegistryCapacityError, true);
    assertEquals((err as RegistryCapacityError).code, "already_registered");
    resolve2();
  }

  // Winner is still intact, running, and cancellable
  const winner = reg.get("resume-123");
  assertEquals(winner !== undefined, true);
  assertEquals(winner!.controller.signal.aborted, false);
  assertEquals(winner!.principalId, "user:alice");
  assertEquals(reg.cancel("resume-123"), true);
  assertEquals(controller1.signal.aborted, true);

  // Loser's controller is untouched
  assertEquals(controller2.signal.aborted, false);

  reg.deregister("resume-123");
  resolve1();
  assertEquals(reg.size, 0);
});

// ── Error message disclosure tests ──────────────────────────────────────

Deno.test("RegistryCapacityError: global_cap message contains numeric limit (server-only)", () => {
  const reg = new ActiveRunRegistry({ maxConcurrent: 42 });
  for (let i = 0; i < 42; i++) {
    reg.register(makeRun(`r${i}`));
  }

  try {
    reg.register(makeRun("overflow"));
    throw new Error("should have thrown");
  } catch (err) {
    const e = err as RegistryCapacityError;
    assertEquals(e.code, "global_cap");
    // The message has the limit (for server logs) — handlers must NOT forward it
    assertEquals(e.message.includes("42"), true);
  }
});

Deno.test("RegistryCapacityError: principal_cap message contains principal and limit (server-only)", () => {
  const reg = new ActiveRunRegistry({ maxPerPrincipal: 3 });
  for (let i = 0; i < 3; i++) {
    reg.register(makeRun(`r${i}`, { principalId: "user:alice" }));
  }

  try {
    reg.register(makeRun("overflow", { principalId: "user:alice" }));
    throw new Error("should have thrown");
  } catch (err) {
    const e = err as RegistryCapacityError;
    assertEquals(e.code, "principal_cap");
    // The message has the principal and limit — handlers must NOT forward it
    assertEquals(e.message.includes("user:alice"), true);
    assertEquals(e.message.includes("3"), true);
  }
});
