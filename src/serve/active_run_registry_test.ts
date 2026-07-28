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
import { type ActiveRun, ActiveRunRegistry } from "./active_run_registry.ts";
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
  completion?: Promise<void>,
): ActiveRun {
  return {
    runId,
    kind: "workflow-run",
    buffer: new RunEventBuffer(100),
    controller: new AbortController(),
    startedAt: new Date(),
    completion: completion ?? Promise.resolve(),
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
  reg.register(makeRun("r1", d1.promise));
  reg.register(makeRun("r2", d2.promise));

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
  reg.register(makeRun("stuck", neverResolves));

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
