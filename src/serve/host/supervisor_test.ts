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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { UserError } from "../../domain/errors.ts";
import {
  type ManagedServePolicy,
  ROOT_SERVE,
  SAFE_RESTART_EXIT_CODE,
  type ServeId,
  workspaceServe,
} from "../../domain/serve/managed_serve.ts";
import type { AuthMode } from "../../domain/access/serve_auth_config.ts";
import type { ListenedServe } from "../listening_line.ts";
import type {
  ServeChild,
  ServeChildExit,
  ServeChildSpec,
  ServeProcessPort,
} from "./serve_process.ts";
import {
  createServeSupervisor,
  type ServeAdmission,
  type ServeStatus,
  type ServeSupervisor,
  type SupervisorClock,
} from "./supervisor.ts";

const POLICY: ManagedServePolicy = {
  restartDelayMs: 500,
  initialBackoffMs: 1_000,
  maxBackoffMs: 3_000,
  crashWindowMs: 600_000,
  maxCrashesInWindow: 10,
};
const READY_TIMEOUT_MS = 7_000;
const STOP_GRACE_MS = 5_000;

class FakeChild implements ServeChild {
  readonly listening: Promise<ListenedServe>;
  readonly ready: Promise<void>;
  readonly exited: Promise<ServeChildExit>;
  terminated = 0;
  killed = 0;
  reloaded = 0;
  released = 0;
  /** a child that ignores terminate exits only when killed or told to */
  ignoresTerminate = false;
  readonly #listening = Promise.withResolvers<ListenedServe>();
  readonly #ready = Promise.withResolvers<void>();
  readonly #exited = Promise.withResolvers<ServeChildExit>();

  constructor(readonly spec: ServeChildSpec) {
    this.listening = this.#listening.promise;
    this.ready = this.#ready.promise;
    this.exited = this.#exited.promise;
    this.listening.catch(() => {});
    this.ready.catch(() => {});
  }

  listen(port: number, authMode: AuthMode = "token"): void {
    this.#listening.resolve({ port, authMode });
  }

  becomeReady(): void {
    this.#ready.resolve();
  }

  /** as the adapter does, unless `settleReady` is false */
  exit(code: number | null, settleReady = true): void {
    this.#listening.reject(new Error("exited"));
    if (settleReady) this.#ready.reject(new Error("exited"));
    this.#exited.resolve({ code, stderrTail: [`exit ${code}`] });
  }

  terminate(): void {
    this.terminated++;
    if (!this.ignoresTerminate) this.exit(0);
  }

  reload(): void {
    this.reloaded++;
  }

  kill(): void {
    this.killed++;
    this.exit(null);
  }

  release(): Promise<void> {
    this.released++;
    return Promise.resolve();
  }
}

class FakePort implements ServeProcessPort {
  readonly children: FakeChild[] = [];
  throwOnNextSpawn = false;

  spawn(spec: ServeChildSpec): ServeChild {
    if (this.throwOnNextSpawn) {
      this.throwOnNextSpawn = false;
      throw new Error("no such binary");
    }
    const child = new FakeChild(spec);
    this.children.push(child);
    return child;
  }

  of(id: ServeId): FakeChild[] {
    return this.children.filter((c) =>
      JSON.stringify(c.spec.id) === JSON.stringify(id)
    );
  }

  last(id: ServeId): FakeChild {
    const all = this.of(id);
    assert(all.length > 0, "no child was spawned");
    return all[all.length - 1];
  }
}

interface FakeTimer {
  readonly fn: () => void;
  readonly ms: number;
  readonly at: number;
  cancelled: boolean;
  fired: boolean;
}

class FakeClock implements SupervisorClock {
  t = 1_000_000;
  readonly timers: FakeTimer[] = [];

  now(): number {
    return this.t;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const timer: FakeTimer = {
      fn,
      ms,
      at: this.t + ms,
      cancelled: false,
      fired: false,
    };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  active(): FakeTimer[] {
    return this.timers.filter((t) => !t.cancelled && !t.fired);
  }

  /** the one live timer set for `ms` */
  armed(ms: number): FakeTimer {
    const matching = this.active().filter((t) => t.ms === ms);
    assertEquals(matching.length, 1, `one live ${ms} ms timer`);
    return matching[0];
  }

  fire(timer: FakeTimer): void {
    assert(!timer.cancelled && !timer.fired, "the timer is still live");
    this.t = Math.max(this.t, timer.at);
    timer.fired = true;
    timer.fn();
  }
}

function spec(
  id: ServeId,
  extra: Partial<ServeChildSpec> = {},
): ServeChildSpec {
  const name = id.kind === "root" ? "root" : id.name;
  return {
    id,
    repoDir: `/host/${name}`,
    address: `https://serve.example/w/${name}`,
    trustedHost: "serve.example",
    env: { PATH: "/usr/bin" },
    ...extra,
  };
}

function harness(
  admit?: ServeAdmission,
  onStatus?: (status: ServeStatus) => void,
): {
  port: FakePort;
  clock: FakeClock;
  supervisor: ServeSupervisor;
} {
  const port = new FakePort();
  const clock = new FakeClock();
  const supervisor = createServeSupervisor({
    processPort: port,
    admit,
    clock,
    policy: POLICY,
    readyTimeoutMs: READY_TIMEOUT_MS,
    stopGraceMs: STOP_GRACE_MS,
    onStatus,
  });
  return { port, clock, supervisor };
}

async function startReady(
  port: FakePort,
  supervisor: ServeSupervisor,
  id: ServeId,
  listenPort: number,
): Promise<FakeChild> {
  const child = port.last(id);
  child.listen(listenPort);
  child.becomeReady();
  await waitFor(
    () => supervisor.lookup(id)?.observed === "ready",
    "the serve to be ready",
  );
  return child;
}

const EDGE = workspaceServe("edge-dns");

Deno.test("createServeSupervisor: a child that starts and becomes ready", async () => {
  const { port, supervisor } = harness();
  supervisor.add(spec(EDGE));
  assertEquals(port.children.length, 1);
  assertEquals(port.last(EDGE).spec.repoDir, "/host/edge-dns");
  assertEquals(supervisor.lookup(EDGE)?.observed, "starting");

  const child = port.last(EDGE);
  child.listen(41_001);
  await waitFor(
    () => child.listening.then(() => true),
    "the listening line to be read",
  );
  assertEquals(supervisor.lookup(EDGE)?.port, null, "no port before ready");

  await startReady(port, supervisor, EDGE, 41_001);
  const status = supervisor.lookup(EDGE);
  assertEquals(status?.observed, "ready");
  assertEquals(status?.wanted, "running");
  assertEquals(status?.port, 41_001);
  assertEquals(status?.crashCount, 0);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: an exit 75 restarts after the restart delay without counting a crash", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const child = await startReady(port, supervisor, EDGE, 41_001);

  child.exit(SAFE_RESTART_EXIT_CODE);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "backoff",
    "the serve to back off",
  );
  assertEquals(supervisor.lookup(EDGE)?.crashCount, 0);
  assertEquals(supervisor.lookup(EDGE)?.port, null);
  assertEquals(child.released, 1);

  clock.fire(clock.armed(POLICY.restartDelayMs));
  assertEquals(port.of(EDGE).length, 2);
  assertEquals(supervisor.lookup(EDGE)?.observed, "starting");
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: an exit 75 before ready backs off and keeps retrying without a crash", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const delays: number[] = [];
  for (let refusal = 1; refusal <= POLICY.maxCrashesInWindow + 2; refusal++) {
    port.last(EDGE).exit(SAFE_RESTART_EXIT_CODE);
    await waitFor(
      () => supervisor.lookup(EDGE)?.observed === "backoff",
      `refusal ${refusal} to back off`,
    );
    const [retry] = clock.active();
    delays.push(retry.ms);
    clock.fire(retry);
    assertEquals(port.of(EDGE).length, refusal + 1);
  }
  assertEquals(supervisor.lookup(EDGE)?.crashCount, 0);
  assertEquals(supervisor.lookup(EDGE)?.observed, "starting");
  assertEquals(delays.slice(0, 2), [
    POLICY.initialBackoffMs,
    POLICY.initialBackoffMs * 2,
  ]);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a crash backs off, doubling up to the cap", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const delays: number[] = [];
  for (let crash = 1; crash <= 4; crash++) {
    port.last(EDGE).exit(1);
    await waitFor(
      () => supervisor.lookup(EDGE)?.crashCount === crash,
      `crash ${crash} to be counted`,
    );
    const [retry] = clock.active();
    delays.push(retry.ms);
    clock.fire(retry);
    assertEquals(port.of(EDGE).length, crash + 1);
  }
  assertEquals(delays, [1_000, 2_000, 3_000, 3_000]);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: repeated crashes end in failed until a resume", async () => {
  const port = new FakePort();
  const clock = new FakeClock();
  const supervisor = createServeSupervisor({
    processPort: port,
    clock,
    policy: { ...POLICY, maxCrashesInWindow: 3 },
    readyTimeoutMs: READY_TIMEOUT_MS,
    stopGraceMs: STOP_GRACE_MS,
  });
  supervisor.add(spec(EDGE));
  for (let crash = 1; crash <= 3; crash++) {
    port.last(EDGE).exit(1);
    await waitFor(
      () => supervisor.lookup(EDGE)?.crashCount === crash,
      `crash ${crash} to be counted`,
    );
    if (crash < 3) clock.fire(clock.active()[0]);
  }
  assertEquals(supervisor.lookup(EDGE)?.observed, "failed");
  assertEquals(clock.active(), [], "no retry is scheduled");
  assertEquals(port.of(EDGE).length, 3);

  supervisor.resume(EDGE);
  assertEquals(port.of(EDGE).length, 4);
  assertEquals(supervisor.lookup(EDGE)?.observed, "starting");
  assertEquals(supervisor.lookup(EDGE)?.crashCount, 0);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a stop terminates once and the exit is not a crash", async () => {
  const { port, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const child = await startReady(port, supervisor, EDGE, 41_001);

  supervisor.setWanted(EDGE, "suspended");
  supervisor.setWanted(EDGE, "suspended");
  assertEquals(child.terminated, 1);
  child.exit(0);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the serve to stop",
  );
  assertEquals(supervisor.lookup(EDGE)?.crashCount, 0);
  assertEquals(port.of(EDGE).length, 1, "a suspended serve is not restarted");

  supervisor.setWanted(EDGE, "running");
  assertEquals(port.of(EDGE).length, 2);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a child that ignores the stop is killed after the stop grace", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const child = await startReady(port, supervisor, EDGE, 41_001);
  child.ignoresTerminate = true;

  supervisor.setWanted(EDGE, "suspended");
  clock.fire(clock.armed(STOP_GRACE_MS));
  assertEquals(child.killed, 1);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the serve to stop",
  );
  assertEquals(clock.active(), []);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a spec's own stop grace replaces the default", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE, { stopGraceMs: 9_000 }));
  const child = await startReady(port, supervisor, EDGE, 41_001);
  child.ignoresTerminate = true;

  supervisor.setWanted(EDGE, "suspended");
  assertEquals(clock.active().map((t) => t.ms), [9_000]);
  clock.fire(clock.armed(9_000));
  assertEquals(child.killed, 1);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a child not ready by the deadline is stopped and counted as a crash", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const child = port.last(EDGE);
  child.ignoresTerminate = true;
  child.listen(41_001);

  clock.fire(clock.armed(READY_TIMEOUT_MS));
  assertEquals(child.terminated, 1);
  // a late ready from a child being stopped does not promote it
  child.becomeReady();
  child.exit(0, false);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "backoff",
    "the serve to back off",
  );
  assertEquals(supervisor.lookup(EDGE)?.crashCount, 1);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a spawn that throws counts as a crash", async () => {
  const { port, clock, supervisor } = harness();
  port.throwOnNextSpawn = true;
  supervisor.add(spec(EDGE));
  const status = supervisor.lookup(EDGE);
  assertEquals(status?.observed, "backoff");
  assertEquals(status?.crashCount, 1);
  assertEquals(status?.lastExit, {
    code: null,
    stderrTail: ["no such binary"],
  });

  clock.fire(clock.armed(POLICY.initialBackoffMs));
  assertEquals(port.of(EDGE).length, 1);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: events from an earlier child are ignored", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  const first = port.last(EDGE);
  first.exit(1, false);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "backoff",
    "the serve to back off",
  );
  clock.fire(clock.armed(POLICY.initialBackoffMs));
  const second = port.last(EDGE);
  assert(second !== first);

  first.becomeReady();
  // the supervisor's handler was attached first, so it has run by now
  await first.ready;
  assertEquals(supervisor.lookup(EDGE)?.observed, "starting");

  second.listen(41_002);
  second.becomeReady();
  await waitFor(
    () => supervisor.lookup(EDGE)?.port === 41_002,
    "the second child's port",
  );
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: refuses a known id, an unknown id and a bad setting", async () => {
  const { supervisor } = harness();
  supervisor.add(spec(EDGE));
  assertThrows(() => supervisor.add(spec(EDGE)), UserError, "already");
  assertThrows(
    () => supervisor.setWanted(workspaceServe("nope"), "suspended"),
    UserError,
    "No serve workspace:nope",
  );
  assertThrows(() => supervisor.resume(ROOT_SERVE), UserError, "No serve root");
  assertThrows(
    () => supervisor.add(spec(ROOT_SERVE, { stopGraceMs: 0 })),
    UserError,
    "stopGraceMs",
  );
  assertEquals(supervisor.lookup(ROOT_SERVE), undefined);
  assertThrows(
    () =>
      createServeSupervisor({
        processPort: new FakePort(),
        readyTimeoutMs: 1.5,
      }),
    UserError,
    "readyTimeoutMs",
  );
  assertThrows(
    () =>
      createServeSupervisor({ processPort: new FakePort(), stopGraceMs: -1 }),
    UserError,
    "stopGraceMs",
  );
  assertThrows(
    () =>
      createServeSupervisor({
        processPort: new FakePort(),
        policy: { ...POLICY, maxBackoffMs: 1 },
      }),
    UserError,
    "restart policy",
  );
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: shutdown stops every child through its drain path and starts nothing", async () => {
  const { port, clock, supervisor } = harness();
  const backingOff = workspaceServe("cost-reports");
  supervisor.add(spec(ROOT_SERVE));
  supervisor.add(spec(EDGE));
  supervisor.add(spec(backingOff));
  const root = await startReady(port, supervisor, ROOT_SERVE, 41_000);
  const edge = await startReady(port, supervisor, EDGE, 41_001);
  port.last(backingOff).exit(1);
  await waitFor(
    () => supervisor.lookup(backingOff)?.observed === "backoff",
    "one serve to back off",
  );
  edge.ignoresTerminate = true;
  const spawned = port.children.length;

  const done = supervisor.shutdown();
  assert(supervisor.shutdown() === done, "a second call shares the first");
  assertEquals(root.terminated, 1);
  assertEquals(edge.terminated, 1);
  assertThrows(() => supervisor.add(spec(workspaceServe("late"))), UserError);
  assertThrows(() => supervisor.setWanted(EDGE, "running"), UserError);

  // the root exited on terminate, which ManagedServe reads as a crash that
  // must not restart it now
  await waitFor(() => root.released === 1, "the root to be released");
  clock.fire(clock.armed(STOP_GRACE_MS));
  assertEquals(edge.killed, 1);
  await done;

  assertEquals(port.children.length, spawned);
  assertEquals(clock.active(), []);
  for (const child of port.children) assertEquals(child.released, 1);
});

Deno.test("createServeSupervisor: reload asks only the ready children, never one starting or stopping", async () => {
  const { port, supervisor } = harness();
  const starting = workspaceServe("cost-reports");
  const stopping = workspaceServe("billing");
  supervisor.add(spec(ROOT_SERVE));
  supervisor.add(spec(EDGE));
  supervisor.add(spec(starting));
  supervisor.add(spec(stopping));
  const root = await startReady(port, supervisor, ROOT_SERVE, 41_000);
  const edge = await startReady(port, supervisor, EDGE, 41_001);
  port.last(starting).listen(41_002);
  const leaving = await startReady(port, supervisor, stopping, 41_003);
  leaving.ignoresTerminate = true;
  supervisor.setWanted(stopping, "suspended");

  assertEquals(supervisor.reload(), 2);
  assertEquals(root.reloaded, 1);
  assertEquals(edge.reloaded, 1);
  assertEquals(port.last(starting).reloaded, 0);
  assertEquals(leaving.reloaded, 0);
  assertEquals(supervisor.lookup(EDGE)?.observed, "ready");
  leaving.exit(0);
  await supervisor.shutdown();
});

const REFUSE_NONE: ServeAdmission = (_spec, listened) =>
  listened.authMode === "none" ? "auth mode none is not allowed here" : null;

Deno.test("createServeSupervisor: an admitted child reports its auth mode and no refusal", async () => {
  const { port, supervisor } = harness(REFUSE_NONE);
  supervisor.add(spec(EDGE));
  await startReady(port, supervisor, EDGE, 41_001);
  const status = supervisor.lookup(EDGE);
  assertEquals(status?.authMode, "token");
  assertEquals(status?.refusal, null);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a refused child is stopped as asked, holds stopped and never becomes ready", async () => {
  const { port, clock, supervisor } = harness(REFUSE_NONE);
  supervisor.add(spec(EDGE));
  const child = port.last(EDGE);
  child.listen(41_001, "none");
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the refused serve to stop",
  );
  child.becomeReady();
  const status = supervisor.lookup(EDGE);
  assertEquals(child.terminated, 1);
  assertEquals(status?.wanted, "suspended");
  assertEquals(status?.observed, "stopped");
  assertEquals(status?.port, null);
  assertEquals(status?.crashCount, 0);
  assertEquals(status?.refusal, "auth mode none is not allowed here");
  assertEquals(port.of(EDGE).length, 1, "no restart");
  assertEquals(clock.active().length, 0, "no retry or kill timer left");
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: wanted running clears a refusal and starts the serve again", async () => {
  const { port, supervisor } = harness(REFUSE_NONE);
  supervisor.add(spec(EDGE));
  port.last(EDGE).listen(41_001, "none");
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the refused serve to stop",
  );
  supervisor.setWanted(EDGE, "running");
  assertEquals(supervisor.lookup(EDGE)?.refusal, null);
  assertEquals(port.of(EDGE).length, 2);
  await startReady(port, supervisor, EDGE, 41_002);
  assertEquals(supervisor.lookup(EDGE)?.port, 41_002);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: an admission check that throws refuses the child", async () => {
  const { port, supervisor } = harness(() => {
    throw new Error("cannot decide");
  });
  supervisor.add(spec(EDGE));
  port.last(EDGE).listen(41_001);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the refused serve to stop",
  );
  assertEquals(supervisor.lookup(EDGE)?.refusal, "cannot decide");
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a deleted serve wanted running again starts a new child", async () => {
  const { port, supervisor } = harness();
  supervisor.add(spec(EDGE));
  await startReady(port, supervisor, EDGE, 41_001);
  supervisor.setWanted(EDGE, "deleted");
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the deleted serve to stop",
  );
  supervisor.setWanted(EDGE, "running");
  assertEquals(port.of(EDGE).length, 2);
  await startReady(port, supervisor, EDGE, 41_002);
  assertEquals(supervisor.lookup(EDGE)?.wanted, "running");
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: a serve added as suspended is never spawned until it is wanted running", () => {
  const { port, supervisor } = harness();
  supervisor.add(spec(EDGE), "suspended");
  assertEquals(port.children.length, 0);
  assertEquals(supervisor.lookup(EDGE)?.wanted, "suspended");
  assertEquals(supervisor.lookup(EDGE)?.observed, "stopped");
  supervisor.setWanted(EDGE, "running");
  assertEquals(port.children.length, 1);
});

Deno.test("createServeSupervisor: onStatus reports each change of state once", async () => {
  const seen: string[] = [];
  const { port, supervisor } = harness(undefined, (status) => {
    seen.push(`${status.wanted}/${status.observed}/${status.restarts}`);
  });
  supervisor.add(spec(EDGE));
  await startReady(port, supervisor, EDGE, 41_001);
  supervisor.reload();
  supervisor.setWanted(EDGE, "suspended");
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the serve to stop",
  );
  assertEquals(seen, [
    "running/starting/0",
    "running/ready/0",
    "suspended/ready/0",
    "suspended/stopped/0",
  ]);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: onStatus that throws is logged and the serve carries on", async () => {
  const { port, supervisor } = harness(undefined, () => {
    throw new Error("disk full");
  });
  supervisor.add(spec(EDGE));
  await startReady(port, supervisor, EDGE, 41_001);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: restarts counts spawns after an unrequested exit, not a stop the host asked for", async () => {
  const { port, clock, supervisor } = harness();
  supervisor.add(spec(EDGE));
  port.last(EDGE).exit(1);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "backoff",
    "the serve to back off",
  );
  assertEquals(supervisor.lookup(EDGE)?.restarts, 0);
  clock.fire(clock.armed(POLICY.initialBackoffMs));
  assertEquals(supervisor.lookup(EDGE)?.restarts, 1);

  await startReady(port, supervisor, EDGE, 41_001);
  supervisor.setWanted(EDGE, "suspended");
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "stopped",
    "the serve to stop",
  );
  supervisor.setWanted(EDGE, "running");
  assertEquals(port.of(EDGE).length, 3);
  assertEquals(supervisor.lookup(EDGE)?.restarts, 1);

  port.throwOnNextSpawn = true;
  await startReady(port, supervisor, EDGE, 41_002);
  port.last(EDGE).exit(SAFE_RESTART_EXIT_CODE);
  await waitFor(
    () => supervisor.lookup(EDGE)?.observed === "backoff",
    "the serve to back off",
  );
  clock.fire(clock.armed(POLICY.restartDelayMs));
  assertEquals(supervisor.lookup(EDGE)?.restarts, 2, "a failed spawn counts");
  // the failed spawn is the second crash, so the backoff has doubled
  clock.fire(clock.armed(POLICY.initialBackoffMs * 2));
  assertEquals(supervisor.lookup(EDGE)?.restarts, 3);
  await supervisor.shutdown();
});

Deno.test("createServeSupervisor: whenStopped settles once the child exits, at once with no child, and on shutdown", async () => {
  const { port, supervisor } = harness();
  supervisor.add(spec(EDGE), "suspended");
  await supervisor.whenStopped(EDGE);

  supervisor.setWanted(EDGE, "running");
  const child = await startReady(port, supervisor, EDGE, 41_001);
  child.ignoresTerminate = true;
  let stopped = false;
  const waiting = supervisor.whenStopped(EDGE).then(() => stopped = true);
  supervisor.setWanted(EDGE, "deleted");
  await Promise.resolve();
  assertEquals(stopped, false, "a child still draining is not stopped");
  child.exit(0);
  await waiting;
  assertEquals(supervisor.lookup(EDGE)?.observed, "stopped");

  supervisor.setWanted(EDGE, "running");
  await startReady(port, supervisor, EDGE, 41_002);
  const onShutdown = supervisor.whenStopped(EDGE);
  await supervisor.shutdown();
  await onShutdown;
});
