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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  enrolledWorkerState,
  nextWorkerState,
  parseStoredWorkerState,
  reassertDecision,
  SetStatusArgsSchema,
  statusWriteBase,
  WORKER_MODEL_TYPE,
  workerModel,
  WorkerStateSchema,
} from "./worker_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const enrollArgs = {
  instanceUuid: "uuid-1",
  tokenName: "ci-runner-3",
  labels: { region: "us-east" },
  platform: "linux",
  arch: "x86_64",
  swampVersion: "1.0.0",
  protocolVersion: 1,
  capacity: 1,
};

Deno.test("workerModel: enroll records an idle worker", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  const result = await workerModel.methods.enroll.execute(enrollArgs, context);
  assertEquals(result.dataHandles?.length, 1);
  const state = store.get("state-main")!;
  assertEquals(state.status, "idle");
  assertEquals(state.name, "ci-runner-3");
  assertEquals(state.instanceUuid, "uuid-1");
  assertEquals(state.capacity, 1);
  assertEquals(state.activeDispatchIds, []);
  assertEquals((state.labels as Record<string, string>).region, "us-east");
});

Deno.test("workerModel: enroll records the token mint when given and omits it otherwise", async () => {
  const mint = "2026-11-02T09:00:00.000Z";
  const withMint = createInMemoryWorkerContext(WORKER_MODEL_TYPE, "w-mint");
  await workerModel.methods.enroll.execute(
    { ...enrollArgs, tokenCreatedAt: mint },
    withMint.context,
  );
  assertEquals(withMint.store.get("state-main")!.tokenCreatedAt, mint);

  const without = createInMemoryWorkerContext(WORKER_MODEL_TYPE, "w-none");
  await workerModel.methods.enroll.execute(enrollArgs, without.context);
  assertEquals("tokenCreatedAt" in without.store.get("state-main")!, false);
});

Deno.test("workerModel: set_status carries the token mint forward and records a new one", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  const mint = "2026-11-02T09:00:00.000Z";
  const reminted = "2026-11-02T09:30:00.000Z";
  await workerModel.methods.enroll.execute(
    { ...enrollArgs, tokenCreatedAt: mint },
    context,
  );
  await workerModel.methods.set_status.execute({ status: "busy" }, context);
  assertEquals(store.get("state-main")!.tokenCreatedAt, mint);
  await workerModel.methods.set_status.execute(
    { status: "idle", tokenCreatedAt: reminted },
    context,
  );
  assertEquals(store.get("state-main")!.tokenCreatedAt, reminted);
});

Deno.test("workerModel: set_status accepts a token mint in its arguments", () => {
  const mint = "2026-11-02T09:00:00.000Z";
  assertEquals(
    SetStatusArgsSchema.parse({
      status: "idle",
      tokenCreatedAt: mint,
    }).tokenCreatedAt,
    mint,
  );
});

Deno.test("workerModel: set_status busy records the dispatch id", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  await workerModel.methods.set_status.execute(
    { status: "busy", activeDispatchIds: ["d-42"] },
    context,
  );
  const state = store.get("state-main")!;
  assertEquals(state.status, "busy");
  assertEquals(state.activeDispatchIds, ["d-42"]);
});

Deno.test("workerModel: set_status idle clears the dispatch id", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  await workerModel.methods.set_status.execute(
    { status: "busy", activeDispatchIds: ["d-42"] },
    context,
  );
  await workerModel.methods.set_status.execute({ status: "idle" }, context);
  const state = store.get("state-main")!;
  assertEquals(state.status, "idle");
  assertEquals(state.activeDispatchIds, []);
});

Deno.test("workerModel: set_status disconnected stamps disconnectedAt", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  await workerModel.methods.set_status.execute(
    { status: "disconnected" },
    context,
  );
  const state = store.get("state-main")!;
  assertEquals(state.status, "disconnected");
  assertEquals(typeof state.disconnectedAt, "string");
});

Deno.test("workerModel: enroll records the starting status it is given", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(
    { ...enrollArgs, status: "unverified" },
    context,
  );
  const state = store.get("state-main")!;
  assertEquals(state.status, "unverified");
  assertEquals(state.verifyFailureReason, undefined);
  assertEquals(state.activeDispatchIds, []);
});

Deno.test("workerModel: enroll accepts only idle or unverified as a starting status", () => {
  const args = workerModel.methods.enroll.arguments;
  assertEquals(args.safeParse({ ...enrollArgs, status: "idle" }).success, true);
  assertEquals(
    args.safeParse({ ...enrollArgs, status: "unverified" }).success,
    true,
  );
  for (const status of ["busy", "disconnected", "draining"]) {
    assertEquals(args.safeParse({ ...enrollArgs, status }).success, false);
  }
});

Deno.test("workerModel: set_status before enroll fails loudly", async () => {
  const { context } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ghost",
  );
  await assertRejects(
    () => workerModel.methods.set_status.execute({ status: "idle" }, context),
    Error,
    "no recorded state",
  );
});

Deno.test("workerModel: every status change is a new version (history)", async () => {
  const { context, versions } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  await workerModel.methods.set_status.execute(
    { status: "busy", dispatchId: "d-1" },
    context,
  );
  await workerModel.methods.set_status.execute({ status: "idle" }, context);
  assertEquals(versions.get("state-main"), 3);
});

const storedWorker = {
  name: "ci-runner-3",
  instanceUuid: "uuid-1",
  tokenName: "ci-runner-3",
  status: "busy" as const,
  labels: { region: "us-east" },
  platform: "linux",
  arch: "x86_64",
  swampVersion: "1.0.0",
  protocolVersion: 1,
  enrolledAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-01T00:00:00.000Z",
  capacity: 2,
  activeDispatchIds: ["d-1"],
};

Deno.test("nextWorkerState: busy keeps the given dispatch ids and stamps lastSeenAt", () => {
  const now = new Date("2026-11-02T10:00:00.000Z");
  const next = nextWorkerState(
    storedWorker,
    { status: "busy", activeDispatchIds: ["d-1", "d-2"] },
    now,
  );
  assertEquals(next, {
    ...storedWorker,
    status: "busy",
    lastSeenAt: now.toISOString(),
    activeDispatchIds: ["d-1", "d-2"],
    verifyFailureReason: undefined,
  });
});

Deno.test("nextWorkerState: unverified keeps its failure reason, and the next status drops it", () => {
  const now = new Date("2026-11-02T10:00:00.000Z");
  const unverified = nextWorkerState(
    storedWorker,
    { status: "unverified", verifyFailureReason: "probe failed" },
    now,
  );
  assertEquals(unverified.verifyFailureReason, "probe failed");
  assertEquals(unverified.activeDispatchIds, ["d-1"]);
  const idle = nextWorkerState(unverified, { status: "idle" }, now);
  assertEquals(idle.verifyFailureReason, undefined);
  assertEquals(idle.activeDispatchIds, []);
});

Deno.test("nextWorkerState: keeps the token mint unless the change names a new one", () => {
  const now = new Date("2026-11-02T10:00:00.000Z");
  const bound = { ...storedWorker, tokenCreatedAt: "2026-11-02T09:00:00.000Z" };
  assertEquals(
    nextWorkerState(bound, { status: "disconnected" }, now).tokenCreatedAt,
    "2026-11-02T09:00:00.000Z",
  );
  assertEquals(
    nextWorkerState(
      bound,
      { status: "idle", tokenCreatedAt: "2026-11-02T09:30:00.000Z" },
      now,
    ).tokenCreatedAt,
    "2026-11-02T09:30:00.000Z",
  );
  assertEquals(
    "tokenCreatedAt" in nextWorkerState(storedWorker, { status: "idle" }, now),
    false,
  );
});

Deno.test("parseStoredWorkerState: nothing stored names the worker's definition", () => {
  assertThrows(
    () => parseStoredWorkerState("worker-ci-runner-3", null),
    Error,
    "Worker 'worker-ci-runner-3' has no recorded state",
  );
  assertEquals(
    parseStoredWorkerState("worker-ci-runner-3", { ...storedWorker }),
    storedWorker,
  );
});

Deno.test("workerModel: set_status output records expire after a day", () => {
  assertEquals(workerModel.methods.set_status.outputLifetime, "1d");
});

Deno.test("workerModel: enroll and set_status record the owning serve process, and a status write without one keeps it", async () => {
  const owner = { instanceId: "serve-a", pid: 4101, host: "host-1" };
  const next = { instanceId: "serve-b", pid: 4102, host: "host-1" };
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "w-owned",
  );
  await workerModel.methods.enroll.execute({ ...enrollArgs, owner }, context);
  assertEquals(store.get("state-main")!.owner, owner);
  await workerModel.methods.set_status.execute({ status: "busy" }, context);
  assertEquals(store.get("state-main")!.owner, owner);
  await workerModel.methods.set_status.execute(
    { status: "idle", owner: next },
    context,
  );
  assertEquals(store.get("state-main")!.owner, next);
});

Deno.test("WorkerStateSchema: a malformed owner reads as none", () => {
  const parsed = WorkerStateSchema.parse({
    ...storedWorker,
    owner: { instanceId: 7 },
  });
  assertEquals(parsed.owner, undefined);
});

const liveEnrollment = { ...enrollArgs, instanceUuid: "uuid-live" };
const at = new Date("2026-11-25T12:00:00.000Z");

function storedState(
  instanceUuid: string,
  status: "idle" | "busy" | "disconnected" | "draining" | "unverified",
): Record<string, unknown> {
  return {
    ...enrolledWorkerState({ ...enrollArgs, instanceUuid }, at),
    status,
  };
}

Deno.test("enrolledWorkerState: builds the record the enroll method writes", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  const written = WorkerStateSchema.parse(store.get("state-main"));
  const built = enrolledWorkerState(
    enrollArgs,
    new Date(written.enrolledAt),
  );
  assertEquals(built, written);
});

Deno.test("statusWriteBase: without a live enrollment a missing record still throws", () => {
  assertThrows(
    () => statusWriteBase("worker-w", null, { status: "busy" }, undefined, at),
    Error,
    "has no recorded state",
  );
});

Deno.test("statusWriteBase: a missing record is rebuilt from the live enrollment", () => {
  const result = statusWriteBase(
    "worker-w",
    null,
    { status: "busy" },
    liveEnrollment,
    at,
  );
  assertEquals(result.kind, "write");
  if (result.kind !== "write") return;
  assertEquals(result.base.instanceUuid, "uuid-live");
  assertEquals(result.base.enrolledAt, at.toISOString());
});

Deno.test("statusWriteBase: another instance's record is replaced for an in-pool status", () => {
  const result = statusWriteBase(
    "worker-w",
    storedState("uuid-old", "disconnected"),
    { status: "idle" },
    liveEnrollment,
    at,
  );
  assertEquals(result.kind, "write");
  if (result.kind !== "write") return;
  assertEquals(result.base.instanceUuid, "uuid-live");
});

Deno.test("statusWriteBase: the record of the same instance is kept as the base", () => {
  const stored = storedState("uuid-live", "busy");
  const result = statusWriteBase(
    "worker-w",
    stored,
    { status: "idle" },
    liveEnrollment,
    at,
  );
  assertEquals(result, {
    kind: "write",
    base: WorkerStateSchema.parse(stored),
  });
});

Deno.test("statusWriteBase: a departure never stamps another instance's record", () => {
  for (const status of ["disconnected", "draining"] as const) {
    assertEquals(
      statusWriteBase(
        "worker-w",
        storedState("uuid-newer", "idle"),
        { status },
        liveEnrollment,
        at,
      ),
      { kind: "skip" },
    );
    assertEquals(
      statusWriteBase("worker-w", null, { status }, liveEnrollment, at),
      { kind: "skip" },
    );
  }
});

Deno.test("statusWriteBase: a disconnect of the recorded instance is written", () => {
  const result = statusWriteBase(
    "worker-w",
    storedState("uuid-live", "idle"),
    { status: "disconnected" },
    liveEnrollment,
    at,
  );
  assertEquals(result.kind, "write");
});

Deno.test("reassertDecision: rewrites a record that says the worker is gone, and leaves another serve's live instance", () => {
  const thisServe = { instanceId: "serve-a", pid: 10 };
  const otherServe = { instanceId: "serve-b", pid: 20 };
  const live = { ...liveEnrollment, owner: thisServe };
  const parse = (
    uuid: string,
    status: Parameters<typeof storedState>[1],
    owner?: { instanceId: string; pid: number },
  ) =>
    WorkerStateSchema.parse({
      ...storedState(uuid, status),
      ...(owner ? { owner } : {}),
    });
  assertEquals(reassertDecision(null, live), "rewrite");
  assertEquals(
    reassertDecision(parse("uuid-live", "disconnected"), live),
    "rewrite",
  );
  assertEquals(reassertDecision(parse("uuid-live", "idle"), live), "keep");
  assertEquals(
    reassertDecision(parse("uuid-live", "idle", thisServe), live),
    "keep",
  );
  assertEquals(
    reassertDecision(parse("uuid-live", "idle", otherServe), live),
    "rewrite",
  );
  assertEquals(
    reassertDecision(parse("uuid-old", "disconnected", otherServe), live),
    "rewrite",
  );
  assertEquals(
    reassertDecision(parse("uuid-old", "draining", otherServe), live),
    "rewrite",
  );
  for (const status of ["idle", "busy", "unverified"] as const) {
    assertEquals(
      reassertDecision(parse("uuid-other", status, otherServe), live),
      "live_elsewhere",
    );
    assertEquals(
      reassertDecision(parse("uuid-other", status, thisServe), live),
      "rewrite",
    );
    assertEquals(
      reassertDecision(parse("uuid-other", status), live),
      "rewrite",
    );
  }
});

Deno.test("statusWriteBase: an in-pool write leaves another serve's live instance and rebuilds over a gone one", () => {
  const thisServe = { instanceId: "serve-a", pid: 10 };
  const otherServe = { instanceId: "serve-b", pid: 20 };
  const live = { ...liveEnrollment, owner: thisServe };
  const liveThere = { ...storedState("uuid-other", "idle"), owner: otherServe };
  assertEquals(
    statusWriteBase("worker-w", liveThere, { status: "busy" }, live, at),
    { kind: "skip" },
  );
  const goneThere = {
    ...storedState("uuid-other", "disconnected"),
    owner: otherServe,
  };
  const rebuilt = statusWriteBase(
    "worker-w",
    goneThere,
    { status: "busy" },
    live,
    at,
  );
  assertEquals(rebuilt.kind, "write");
});

Deno.test("statusWriteBase: a departure skips the same instance's record when another serve owns it", () => {
  const thisServe = { instanceId: "serve-a", pid: 10 };
  const otherServe = { instanceId: "serve-b", pid: 20 };
  const live = { ...liveEnrollment, owner: thisServe };
  const movedAway = { ...storedState("uuid-live", "idle"), owner: otherServe };
  assertEquals(
    statusWriteBase(
      "worker-w",
      movedAway,
      { status: "disconnected" },
      live,
      at,
    ),
    { kind: "skip" },
  );
  const stillOurs = { ...storedState("uuid-live", "idle"), owner: thisServe };
  assertEquals(
    statusWriteBase("worker-w", stillOurs, { status: "disconnected" }, live, at)
      .kind,
    "write",
  );
  const unowned = storedState("uuid-live", "idle");
  assertEquals(
    statusWriteBase("worker-w", unowned, { status: "disconnected" }, live, at)
      .kind,
    "write",
  );
});

Deno.test("statusWriteBase: a malformed stored record is rebuilt for an in-pool status and left for a departure", () => {
  const malformed = { name: 42 };
  const rebuilt = statusWriteBase(
    "worker-w",
    malformed,
    { status: "busy" },
    liveEnrollment,
    at,
  );
  assertEquals(rebuilt.kind, "write");
  if (rebuilt.kind === "write") {
    assertEquals(rebuilt.base.instanceUuid, "uuid-live");
  }
  assertEquals(
    statusWriteBase(
      "worker-w",
      malformed,
      { status: "disconnected" },
      liveEnrollment,
      at,
    ),
    { kind: "skip" },
  );
});
