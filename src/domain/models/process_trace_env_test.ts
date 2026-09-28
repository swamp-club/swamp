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
import { ProcessTraceEnv, type TraceEnvStore } from "./process_trace_env.ts";

const A = { traceparent: "00-aaaa-a1a1-01" };
const B = { traceparent: "00-bbbb-b1b1-01" };
const C = { traceparent: "00-cccc-c1c1-01" };

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

Deno.test("ProcessTraceEnv: a lone execution publishes its headers and restores after", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  await traceEnv.run(
    { traceparent: "00-aaaa-a1a1-01", tracestate: "v=1" },
    () => {
      assertEquals(vars.get("TRACEPARENT"), "00-aaaa-a1a1-01");
      assertEquals(vars.get("TRACESTATE"), "v=1");
      return Promise.resolve();
    },
  );

  assertEquals(vars.has("TRACEPARENT"), false);
  assertEquals(vars.has("TRACESTATE"), false);
});

Deno.test("ProcessTraceEnv: returns the callback's result", async () => {
  const traceEnv = new ProcessTraceEnv(fakeEnv().store);

  assertEquals(await traceEnv.run(A, () => Promise.resolve(42)), 42);
});

Deno.test("ProcessTraceEnv: restores the process's inbound values after", async () => {
  const { store, vars } = fakeEnv({
    TRACEPARENT: "00-inbound-0001-01",
    TRACESTATE: "inbound=1",
  });
  const traceEnv = new ProcessTraceEnv(store);

  await traceEnv.run(A, () => {
    assertEquals(vars.get("TRACEPARENT"), A.traceparent);
    // A header the execution does not carry keeps its inbound value.
    assertEquals(vars.get("TRACESTATE"), "inbound=1");
    return Promise.resolve();
  });

  assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
  assertEquals(vars.get("TRACESTATE"), "inbound=1");
});

Deno.test("ProcessTraceEnv: never writes the env when there are no headers", async () => {
  const { store, writes } = fakeEnv({ TRACEPARENT: "00-inbound-0001-01" });
  const traceEnv = new ProcessTraceEnv(store);

  await traceEnv.run(
    undefined,
    () => traceEnv.run({}, () => Promise.resolve()),
  );
  await Promise.all([
    traceEnv.run(undefined, () => Promise.resolve()),
    traceEnv.run({}, () => Promise.resolve()),
  ]);

  assertEquals(writes, []);
});

Deno.test("ProcessTraceEnv: overlapping executions revert the env to its baseline", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);
  const bStarted = Promise.withResolvers<void>();
  const aFinished = Promise.withResolvers<void>();
  const seen: Record<string, string | undefined> = {};

  const runA = traceEnv.run(A, async () => {
    seen.aAlone = vars.get("TRACEPARENT");
    await bStarted.promise;
    // B overlaps A: neither may see the other's span, so the env drops back.
    seen.aOverlapped = vars.get("TRACEPARENT");
  });
  const runB = traceEnv.run(B, async () => {
    seen.bOverlapped = vars.get("TRACEPARENT");
    bStarted.resolve();
    await aFinished.promise;
    // A finished; B is running alone again but the env stays at baseline
    // rather than being re-published mid-execution.
    seen.bAfterA = vars.get("TRACEPARENT");
  });
  await runA;
  aFinished.resolve();
  await runB;

  assertEquals(seen, {
    aAlone: A.traceparent,
    aOverlapped: undefined,
    bOverlapped: undefined,
    bAfterA: undefined,
  });
  assertEquals(vars.has("TRACEPARENT"), false);

  // Once idle, the next lone execution publishes again.
  await traceEnv.run(B, () => {
    assertEquals(vars.get("TRACEPARENT"), B.traceparent);
    return Promise.resolve();
  });
  assertEquals(vars.has("TRACEPARENT"), false);
});

Deno.test("ProcessTraceEnv: overlap restores inbound values, not the first execution's", async () => {
  const { store, vars } = fakeEnv({ TRACEPARENT: "00-inbound-0001-01" });
  const traceEnv = new ProcessTraceEnv(store);
  const bothStarted = Promise.withResolvers<void>();

  const runA = traceEnv.run(A, () => bothStarted.promise);
  const runB = traceEnv.run(B, () => {
    assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
    bothStarted.resolve();
    return Promise.resolve();
  });
  await Promise.all([runA, runB]);

  assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
});

Deno.test("ProcessTraceEnv: a nested execution publishes its headers and hands the env back", async () => {
  const { store, vars } = fakeEnv({ TRACESTATE: "inbound=1" });
  const traceEnv = new ProcessTraceEnv(store);
  const seen: Record<string, string | undefined> = {};

  await traceEnv.run({ ...A, tracestate: "a=1" }, async () => {
    seen.parentBefore = vars.get("TRACEPARENT");
    await traceEnv.run(B, async () => {
      await Promise.resolve();
      seen.child = vars.get("TRACEPARENT");
      // The child carries no tracestate, so it gets the baseline's.
      seen.childState = vars.get("TRACESTATE");
      await traceEnv.run(C, () => {
        seen.grandchild = vars.get("TRACEPARENT");
        return Promise.resolve();
      });
      seen.childAfter = vars.get("TRACEPARENT");
    });
    seen.parentAfter = vars.get("TRACEPARENT");
    seen.parentStateAfter = vars.get("TRACESTATE");
  });

  assertEquals(seen, {
    parentBefore: A.traceparent,
    child: B.traceparent,
    childState: "inbound=1",
    grandchild: C.traceparent,
    childAfter: B.traceparent,
    parentAfter: A.traceparent,
    parentStateAfter: "a=1",
  });
  assertEquals(vars.has("TRACEPARENT"), false);
  assertEquals(vars.get("TRACESTATE"), "inbound=1");
});

Deno.test("ProcessTraceEnv: a nested execution republishes a parent that had no headers", async () => {
  const { store, vars } = fakeEnv({ TRACEPARENT: "00-inbound-0001-01" });
  const traceEnv = new ProcessTraceEnv(store);

  await traceEnv.run(undefined, async () => {
    await traceEnv.run(B, () => {
      assertEquals(vars.get("TRACEPARENT"), B.traceparent);
      return Promise.resolve();
    });
    assertEquals(vars.get("TRACEPARENT"), "00-inbound-0001-01");
  });
});

Deno.test("ProcessTraceEnv: parallel nested executions revert the env to its baseline", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);
  const bothStarted = Promise.withResolvers<void>();
  let started = 0;
  const seen: Array<string | undefined> = [];

  const child = (headers: typeof A) =>
    traceEnv.run(headers, async () => {
      if (++started === 2) bothStarted.resolve();
      await bothStarted.promise;
      seen.push(vars.get("TRACEPARENT"));
    });

  await traceEnv.run(A, async () => {
    await Promise.all([child(B), child(C)]);
    // Siblings overlapped, so the parent does not get the env back until
    // everything finishes.
    seen.push(vars.get("TRACEPARENT"));
  });

  assertEquals(seen, [undefined, undefined, undefined]);
  assertEquals(vars.has("TRACEPARENT"), false);
});

Deno.test("ProcessTraceEnv: a nested execution under overlapping executions stays at baseline", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);
  const bStarted = Promise.withResolvers<void>();
  const aFinished = Promise.withResolvers<void>();
  const seen: Array<string | undefined> = [];

  const runA = traceEnv.run(A, () => bStarted.promise);
  const runB = traceEnv.run(B, async () => {
    bStarted.resolve();
    await aFinished.promise;
    // B is alone again, but the env stays at baseline until idle, so its
    // nested execution does not publish either.
    await traceEnv.run(C, () => {
      seen.push(vars.get("TRACEPARENT"));
      return Promise.resolve();
    });
    seen.push(vars.get("TRACEPARENT"));
  });
  await runA;
  aFinished.resolve();
  await runB;

  assertEquals(seen, [undefined, undefined]);
});

Deno.test("ProcessTraceEnv: an unawaited nested execution keeps its span after its parent exits", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);
  const G = { traceparent: "00-gggg-g1g1-01" };
  const P = { traceparent: "00-pppp-p1p1-01" };
  const C = { traceparent: "00-cccc-c1c1-01" };
  const release = Promise.withResolvers<void>();
  let child: Promise<void> | undefined;
  const seen: Record<string, string | undefined> = {};

  await traceEnv.run(G, async () => {
    // P starts C and returns without awaiting it, so C outlives P.
    await traceEnv.run(P, () => {
      child = traceEnv.run(C, async () => {
        await release.promise;
        seen.cAfterParentExited = vars.get("TRACEPARENT");
      });
      return Promise.resolve();
    });
    release.resolve();
    await child;
    seen.gAfterChildExited = vars.get("TRACEPARENT");
  });

  assertEquals(seen, {
    cAfterParentExited: C.traceparent,
    gAfterChildExited: G.traceparent,
  });
  assertEquals(vars.has("TRACEPARENT"), false);
});

Deno.test("ProcessTraceEnv: ignores non-W3C header keys", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  await traceEnv.run({ "ld-preload": "/tmp/evil.so", ...A }, () => {
    assertEquals(vars.has("LD_PRELOAD"), false);
    assertEquals(vars.get("TRACEPARENT"), A.traceparent);
    return Promise.resolve();
  });
});

Deno.test("ProcessTraceEnv: unwinds when the callback throws", async () => {
  const { store, vars } = fakeEnv();
  const traceEnv = new ProcessTraceEnv(store);

  await assertRejects(
    () => traceEnv.run(A, () => Promise.reject(new Error("boom"))),
    Error,
    "boom",
  );
  assertEquals(vars.has("TRACEPARENT"), false);

  // Bookkeeping stayed balanced, so a later lone execution still publishes.
  await traceEnv.run(B, () => {
    assertEquals(vars.get("TRACEPARENT"), B.traceparent);
    return Promise.resolve();
  });
});

Deno.test("ProcessTraceEnv: a failed write still unwinds", async () => {
  const { store, vars } = fakeEnv();
  const failing: TraceEnvStore = {
    ...store,
    set: (key, value) => {
      if (key === "TRACESTATE") throw new Error("set failed");
      store.set(key, value);
    },
  };
  const traceEnv = new ProcessTraceEnv(failing);
  let ran = false;

  await assertRejects(
    () =>
      traceEnv.run({ ...A, tracestate: "v=1" }, () => {
        ran = true;
        return Promise.resolve();
      }),
    Error,
    "set failed",
  );
  assertEquals(ran, false);
  assertEquals(vars.has("TRACEPARENT"), false);

  // Bookkeeping stayed balanced, so a later lone execution still publishes.
  await traceEnv.run(B, () => {
    assertEquals(vars.get("TRACEPARENT"), B.traceparent);
    return Promise.resolve();
  });
});
