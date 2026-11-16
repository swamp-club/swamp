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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  ManagedServe,
  type ManagedServeAction,
  type ManagedServeEvent,
  type ManagedServePolicy,
  parseManagedServePolicy,
  ROOT_SERVE,
  serveIdKey,
  workspaceServe,
} from "./managed_serve.ts";

const POLICY: ManagedServePolicy = {
  restartDelayMs: 500,
  initialBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  crashWindowMs: 60_000,
  maxCrashesInWindow: 4,
};

const TICK: ManagedServeEvent = { kind: "tick" };
const READY: ManagedServeEvent = { kind: "ready" };
const exited = (code: number | null): ManagedServeEvent => ({
  kind: "exited",
  code,
});
const wanted = (
  state: "running" | "suspended" | "deleted",
): ManagedServeEvent => ({ kind: "wanted", wanted: state });

function run(
  serve: ManagedServe,
  events: ReadonlyArray<readonly [ManagedServeEvent, number]>,
): { serve: ManagedServe; actions: ManagedServeAction[] } {
  const actions: ManagedServeAction[] = [];
  for (const [event, now] of events) {
    const step = serve.step(event, now);
    serve = step.next;
    actions.push(step.action);
  }
  return { serve, actions };
}

function readyServe(): ManagedServe {
  return run(ManagedServe.create(ROOT_SERVE, POLICY), [[TICK, 0], [READY, 0]])
    .serve;
}

function failedServe(): ManagedServe {
  let serve = ManagedServe.create(ROOT_SERVE, POLICY);
  let now = 0;
  for (let i = 0; i < POLICY.maxCrashesInWindow; i++) {
    serve = serve.step(TICK, now).next.step(exited(1), now).next;
    now = serve.retryAt ?? now;
  }
  assertEquals(serve.observed, "failed");
  return serve;
}

Deno.test("ManagedServe.step: a new serve spawns on its first tick", () => {
  const serve = ManagedServe.create(workspaceServe("edge-dns"), POLICY);
  assertEquals(serve.observed, "stopped");
  assertEquals(serve.wanted, "running");
  const { next, action } = serve.step(TICK, 0);
  assertEquals(action, { kind: "spawn" });
  assertEquals(next.observed, "starting");
});

Deno.test("ManagedServe.step: starting becomes ready on a ready event", () => {
  const { serve, actions } = run(ManagedServe.create(ROOT_SERVE, POLICY), [
    [TICK, 0],
    [READY, 10],
  ]);
  assertEquals(serve.observed, "ready");
  assertEquals(actions[1], { kind: "wait" });
});

Deno.test("ManagedServe.step: a ready event outside starting is ignored", () => {
  const stopped = ManagedServe.create(ROOT_SERVE, POLICY);
  assertEquals(stopped.step(READY, 0).next.observed, "stopped");
  const backoff = readyServe().step(exited(1), 100).next;
  assertEquals(backoff.step(READY, 200).next.observed, "backoff");
});

Deno.test("ManagedServe.step: exit 75 restarts after the restart delay and is not a crash", () => {
  const { next, action } = readyServe().step(exited(75), 1_000);
  assertEquals(next.observed, "backoff");
  assertEquals(next.crashCount, 0);
  assertEquals(next.backoffMs, 500);
  assertEquals(action, { kind: "wait", until: 1_500 });
  assertEquals(next.step(TICK, 1_499).action, { kind: "wait", until: 1_500 });
  const restarted = next.step(TICK, 1_500);
  assertEquals(restarted.action, { kind: "spawn" });
  assertEquals(restarted.next.observed, "starting");
});

Deno.test("ManagedServe.step: exit 75 while starting is not a crash either", () => {
  const starting = ManagedServe.create(ROOT_SERVE, POLICY).step(TICK, 0).next;
  const { next } = starting.step(exited(75), 10);
  assertEquals(next.observed, "backoff");
  assertEquals(next.crashCount, 0);
});

Deno.test("ManagedServe.step: an unrequested exit 0 and a null code are crashes", () => {
  for (const code of [0, null, 1, 137]) {
    const { next } = readyServe().step(exited(code), 100);
    assertEquals(next.observed, "backoff");
    assertEquals(next.crashCount, 1);
  }
});

Deno.test("ManagedServe.step: crash backoff doubles and stops at the cap", () => {
  const policy = { ...POLICY, maxCrashesInWindow: 10 };
  let serve = ManagedServe.create(ROOT_SERVE, policy);
  const backoffs: number[] = [];
  let now = 0;
  for (let i = 0; i < 6; i++) {
    serve = serve.step(TICK, now).next;
    const step = serve.step(exited(1), now);
    serve = step.next;
    backoffs.push(serve.backoffMs);
    assertEquals(step.action, { kind: "wait", until: now + serve.backoffMs });
    now = serve.retryAt!;
  }
  assertEquals(backoffs, [1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
});

Deno.test("ManagedServe.step: reaching the crash limit inside the window holds in failed", () => {
  let serve = ManagedServe.create(ROOT_SERVE, POLICY);
  let now = 0;
  for (let i = 0; i < POLICY.maxCrashesInWindow; i++) {
    serve = serve.step(TICK, now).next;
    serve = serve.step(exited(1), now).next;
    now = serve.retryAt ?? now;
  }
  assertEquals(serve.observed, "failed");
  assertEquals(serve.crashCount, POLICY.maxCrashesInWindow);
  assertEquals(serve.retryAt, undefined);
});

Deno.test("ManagedServe.step: crashes spread wider than the window never fail", () => {
  let serve = ManagedServe.create(ROOT_SERVE, POLICY);
  let now = 0;
  for (let i = 0; i < POLICY.maxCrashesInWindow * 3; i++) {
    serve = serve.step(TICK, now).next;
    serve = serve.step(exited(1), now).next;
    assertEquals(serve.observed, "backoff");
    now += POLICY.crashWindowMs;
  }
  assertEquals(serve.crashCount, 1);
  assertEquals(serve.backoffMs, POLICY.initialBackoffMs);
});

Deno.test("ManagedServe.step: failed ignores ticks, exits and wanted changes", () => {
  let serve = failedServe();
  assertEquals(serve.observed, "failed");
  for (
    const event of [
      TICK,
      READY,
      exited(1),
      wanted("suspended"),
      wanted(
        "running",
      ),
      wanted("deleted"),
    ]
  ) {
    const step = serve.step(event, 1_000_000);
    assertEquals(step.next.observed, "failed");
    assertEquals(step.action, { kind: "wait" });
    serve = step.next;
  }
  assertEquals(serve.wanted, "deleted");
});

Deno.test("ManagedServe.step: resume leaves failed, clears the crashes and spawns", () => {
  let serve = failedServe();
  serve = serve.step(wanted("suspended"), 10).next;
  const { next, action } = serve.step({ kind: "resume" }, 20);
  assertEquals(action, { kind: "spawn" });
  assertEquals(next.observed, "starting");
  assertEquals(next.wanted, "running");
  assertEquals(next.crashCount, 0);
  assertEquals(next.backoffMs, 0);
});

Deno.test("ManagedServe.step: suspend or delete while ready stops, then the exit leaves it stopped without a crash", () => {
  for (const state of ["suspended", "deleted"] as const) {
    const stopping = readyServe().step(wanted(state), 100);
    assertEquals(stopping.action, { kind: "stop" });
    assertEquals(stopping.next.observed, "ready");
    assertEquals(stopping.next.stopRequested, true);
    assertEquals(stopping.next.step(wanted(state), 110).action, {
      kind: "wait",
    });
    const { next, action } = stopping.next.step(exited(1), 200);
    assertEquals(next.observed, "stopped");
    assertEquals(next.stopRequested, false);
    assertEquals(next.crashCount, 0);
    assertEquals(action, { kind: "wait" });
    assertEquals(next.step(TICK, 300).action, { kind: "wait" });
  }
});

Deno.test("ManagedServe.step: a ready event during a requested stop keeps the stop pending", () => {
  const starting = ManagedServe.create(ROOT_SERVE, POLICY).step(TICK, 0).next;
  const stopping = starting.step(wanted("suspended"), 10).next;
  const { next } = stopping.step(READY, 20);
  assertEquals(next.observed, "ready");
  assertEquals(next.stopRequested, true);
});

Deno.test("ManagedServe.step: suspend from backoff stops without a stop action", () => {
  const backoff = readyServe().step(exited(1), 100).next;
  const { next, action } = backoff.step(wanted("suspended"), 200);
  assertEquals(action, { kind: "wait" });
  assertEquals(next.observed, "stopped");
  assertEquals(next.retryAt, undefined);
  assertEquals(next.step(TICK, 100_000).action, { kind: "wait" });
});

Deno.test("ManagedServe.step: wanted running during a drain respawns only when the child exits", () => {
  const stopping = readyServe().step(wanted("suspended"), 100).next;
  const resumed = stopping.step(wanted("running"), 110);
  assertEquals(resumed.action, { kind: "wait" });
  assertEquals(resumed.next.stopRequested, true);
  assertEquals(resumed.next.step(TICK, 120).action, { kind: "wait" });
  const { next, action } = resumed.next.step(exited(0), 200);
  assertEquals(action, { kind: "spawn" });
  assertEquals(next.observed, "starting");
  assertEquals(next.stopRequested, false);
  assertEquals(next.crashCount, 0);
});

Deno.test("ManagedServe.step: wanted running from stopped spawns", () => {
  const stopped = readyServe().step(wanted("suspended"), 1).next.step(
    exited(0),
    2,
  ).next;
  const { next, action } = stopped.step(wanted("running"), 3);
  assertEquals(action, { kind: "spawn" });
  assertEquals(next.observed, "starting");
});

Deno.test("ManagedServe.step: an exit when no child runs is ignored", () => {
  const stopped = ManagedServe.create(ROOT_SERVE, POLICY);
  const { next, action } = stopped.step(exited(1), 0);
  assertEquals(next.observed, "stopped");
  assertEquals(next.crashCount, 0);
  assertEquals(action, { kind: "wait" });
  const backoff = readyServe().step(exited(1), 100).next;
  assertEquals(backoff.step(exited(1), 200).next.crashCount, 1);
});

Deno.test("ManagedServe.step: resume outside failed acts as wanted running", () => {
  const serve = readyServe();
  const { next, action } = serve.step({ kind: "resume" }, 0);
  assertEquals(action, { kind: "wait" });
  assertEquals(next.observed, "ready");
});

Deno.test("parseManagedServePolicy: refuses values that are not positive whole numbers", () => {
  for (
    const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
  ) {
    assertThrows(
      () => parseManagedServePolicy({ ...POLICY, crashWindowMs: bad }),
      UserError,
      "crashWindowMs",
    );
  }
});

Deno.test("parseManagedServePolicy: refuses a policy missing a field", () => {
  const { crashWindowMs: _, ...partial } = POLICY;
  assertThrows(
    () => parseManagedServePolicy(partial as ManagedServePolicy),
    UserError,
    "crashWindowMs",
  );
});

Deno.test("parseManagedServePolicy: refuses delays larger than the backoff cap", () => {
  assertThrows(
    () => parseManagedServePolicy({ ...POLICY, initialBackoffMs: 9_000 }),
    UserError,
    "initialBackoffMs",
  );
  assertThrows(
    () => parseManagedServePolicy({ ...POLICY, restartDelayMs: 9_000 }),
    UserError,
    "restartDelayMs",
  );
});

Deno.test("ManagedServe.create: refuses a bad policy and a bad workspace name", () => {
  assertThrows(
    () => ManagedServe.create(ROOT_SERVE, { ...POLICY, maxBackoffMs: 1 }),
    UserError,
  );
  assertThrows(() => workspaceServe("Not A Name"), UserError);
  assertThrows(
    () => ManagedServe.create({ kind: "workspace", name: "../etc" }, POLICY),
    UserError,
  );
});

Deno.test("serveIdKey: a workspace named root never shares the root's key", () => {
  assertNotEquals(serveIdKey(workspaceServe("root")), serveIdKey(ROOT_SERVE));
  assertEquals(
    serveIdKey(workspaceServe("edge-dns")),
    serveIdKey(workspaceServe("edge-dns")),
  );
});
