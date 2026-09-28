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
import { ProcessTraceEnv, type TraceEnvStore } from "./process_trace_env.ts";

const A = { traceparent: "00-aaaa-a1a1-01" };
const B = { traceparent: "00-bbbb-b1b1-01" };

function fakeEnv(initial: Record<string, string> = {}): {
  store: TraceEnvStore;
  vars: Map<string, string>;
  writes: string[];
} {
  const vars = new Map(Object.entries(initial));
  const writes: string[] = [];
  const store: TraceEnvStore = {
    get: (key) => vars.get(key),
    set: (key, value) => {
      writes.push(`set ${key}`);
      vars.set(key, value);
    },
    delete: (key) => {
      writes.push(`delete ${key}`);
      vars.delete(key);
    },
  };
  return { store, vars, writes };
}

Deno.test("ProcessTraceEnv: a lone execution publishes its headers and restores on exit", () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.enter({ traceparent: "00-aaaa-a1a1-01", tracestate: "v=1" });
  assertEquals(vars.get("TRACEPARENT"), "00-aaaa-a1a1-01");
  assertEquals(vars.get("TRACESTATE"), "v=1");

  traceEnv.exit();
  assertEquals(vars.has("TRACEPARENT"), false);
  assertEquals(vars.has("TRACESTATE"), false);
});

Deno.test("ProcessTraceEnv: restores the process's inbound values on exit", () => {
  const { store, vars } = fakeEnv({
    TRACEPARENT: "00-inbound-0001-01",
    TRACESTATE: "inbound=1",
  });
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.enter(A);
  assertEquals(vars.get("TRACEPARENT"), A.traceparent);
  // A header the execution does not carry keeps its inbound value.
  assertEquals(vars.get("TRACESTATE"), "inbound=1");

  traceEnv.exit();
  assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
  assertEquals(vars.get("TRACESTATE"), "inbound=1");
});

Deno.test("ProcessTraceEnv: never writes the env when there are no headers", () => {
  const { store, writes } = fakeEnv({ TRACEPARENT: "00-inbound-0001-01" });
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.enter(undefined);
  traceEnv.enter({});
  traceEnv.exit();
  traceEnv.exit();

  assertEquals(writes, []);
});

Deno.test("ProcessTraceEnv: overlapping executions revert the env to its baseline", () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.enter(A);
  assertEquals(vars.get("TRACEPARENT"), A.traceparent);

  // B overlaps A: neither may see the other's span, so the env drops back.
  traceEnv.enter(B);
  assertEquals(vars.has("TRACEPARENT"), false);

  // A finishes first; B is running alone again but the env stays at baseline
  // rather than being re-published mid-execution.
  traceEnv.exit();
  assertEquals(vars.has("TRACEPARENT"), false);

  traceEnv.exit();
  assertEquals(vars.has("TRACEPARENT"), false);

  // Once idle, the next lone execution publishes again.
  traceEnv.enter(B);
  assertEquals(vars.get("TRACEPARENT"), B.traceparent);
  traceEnv.exit();
  assertEquals(vars.has("TRACEPARENT"), false);
});

Deno.test("ProcessTraceEnv: overlap restores inbound values, not the first execution's", () => {
  const { store, vars } = fakeEnv({ TRACEPARENT: "00-inbound-0001-01" });
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.enter(A);
  traceEnv.enter(B);
  assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
  traceEnv.exit();
  traceEnv.exit();
  assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
});

Deno.test("ProcessTraceEnv: ignores non-W3C header keys", () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.enter({ "ld-preload": "/tmp/evil.so", ...A });
  assertEquals(vars.has("LD_PRELOAD"), false);
  assertEquals(vars.get("TRACEPARENT"), A.traceparent);
  traceEnv.exit();
});

Deno.test("ProcessTraceEnv: a failed write still unwinds on exit", () => {
  const { store, vars } = fakeEnv();
  const failing: TraceEnvStore = {
    ...store,
    set: (key, value) => {
      if (key === "TRACESTATE") throw new Error("set failed");
      store.set(key, value);
    },
  };
  const traceEnv = new ProcessTraceEnv(failing);

  assertThrows(() => traceEnv.enter({ ...A, tracestate: "v=1" }));
  assertEquals(vars.get("TRACEPARENT"), A.traceparent);
  traceEnv.exit();
  assertEquals(vars.has("TRACEPARENT"), false);

  // The count stayed balanced, so a later lone execution still publishes.
  traceEnv.enter(B);
  assertEquals(vars.get("TRACEPARENT"), B.traceparent);
  traceEnv.exit();
});

Deno.test("ProcessTraceEnv: an unpaired exit is a no-op", () => {
  const { store, writes } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  traceEnv.exit();
  assertEquals(writes, []);

  traceEnv.enter(A);
  traceEnv.exit();
  assertEquals(writes, [
    "set TRACEPARENT",
    "delete TRACEPARENT",
    "delete TRACESTATE",
  ]);
});
