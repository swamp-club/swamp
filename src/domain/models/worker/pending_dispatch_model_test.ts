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
  endedPendingDispatch,
  parseStoredPendingDispatch,
  PENDING_DISPATCH_END_METHODS,
  PENDING_DISPATCH_INSTANCE_NAME,
  PENDING_DISPATCH_MODEL_TYPE,
  type PendingDispatch,
  pendingDispatchModel,
  startPendingDispatch,
} from "./pending_dispatch_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const enqueueArgs = {
  queueId: "q-1",
  target: "prod",
  labels: { tier: "smoke" },
  platform: "linux",
  workflowName: "deploy",
  jobName: "main",
  stepName: "build",
  modelType: "@acme/widget",
  methodName: "create",
  queuedAt: "2026-07-04T00:00:00.000Z",
};

function harness() {
  return createInMemoryWorkerContext(
    PENDING_DISPATCH_MODEL_TYPE,
    PENDING_DISPATCH_INSTANCE_NAME,
  );
}

Deno.test("pendingDispatchModel: enqueue records a waiting dispatch", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  const record = store.get("pending-q-1")!;
  assertEquals(record.state, "waiting");
  assertEquals(record.target, "prod");
  assertEquals(record.labels, { tier: "smoke" });
  assertEquals(record.modelType, "@acme/widget");
  assertEquals(record.methodName, "create");
});

Deno.test("pendingDispatchModel: duplicate enqueue fails", async () => {
  const { context } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await assertRejects(
    () => pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context),
    Error,
    "already exists",
  );
});

Deno.test("pendingDispatchModel: mark_dispatched transitions from waiting", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await pendingDispatchModel.methods.mark_dispatched.execute({
    queueId: "q-1",
    dispatchId: "d-1",
    endedAt: "2026-07-04T00:01:00.000Z",
  }, context);
  const record = store.get("pending-q-1")!;
  assertEquals(record.state, "dispatched");
  assertEquals(record.dispatchId, "d-1");
  assertEquals(record.endedAt, "2026-07-04T00:01:00.000Z");
});

Deno.test("pendingDispatchModel: timeout transitions from waiting", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await pendingDispatchModel.methods.timeout.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:05:00.000Z",
  }, context);
  assertEquals(store.get("pending-q-1")!.state, "timed_out");
});

Deno.test("pendingDispatchModel: cancel transitions from waiting", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await pendingDispatchModel.methods.cancel.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:00:30.000Z",
  }, context);
  assertEquals(store.get("pending-q-1")!.state, "cancelled");
});

Deno.test("pendingDispatchModel: orphan transitions from waiting", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await pendingDispatchModel.methods.orphan.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:10:00.000Z",
  }, context);
  assertEquals(store.get("pending-q-1")!.state, "orphaned");
});

Deno.test("pendingDispatchModel: terminal states silently reject further transitions", async () => {
  const { context, store, versions } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await pendingDispatchModel.methods.mark_dispatched.execute({
    queueId: "q-1",
    dispatchId: "d-1",
    endedAt: "2026-07-04T00:01:00.000Z",
  }, context);
  const versionAfterDispatch = versions.get("pending-q-1");

  await pendingDispatchModel.methods.cancel.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:02:00.000Z",
  }, context);
  assertEquals(store.get("pending-q-1")!.state, "dispatched");
  assertEquals(versions.get("pending-q-1"), versionAfterDispatch);

  await pendingDispatchModel.methods.timeout.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:03:00.000Z",
  }, context);
  assertEquals(store.get("pending-q-1")!.state, "dispatched");
  assertEquals(versions.get("pending-q-1"), versionAfterDispatch);
});

Deno.test("pendingDispatchModel: cancel after timeout is a no-op", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute(enqueueArgs, context);
  await pendingDispatchModel.methods.timeout.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:05:00.000Z",
  }, context);
  await pendingDispatchModel.methods.cancel.execute({
    queueId: "q-1",
    endedAt: "2026-07-04T00:06:00.000Z",
  }, context);
  assertEquals(store.get("pending-q-1")!.state, "timed_out");
});

Deno.test("pendingDispatchModel: operations on unknown queue ids fail loudly", async () => {
  const { context } = harness();
  await assertRejects(
    () =>
      pendingDispatchModel.methods.mark_dispatched.execute({
        queueId: "nope",
        dispatchId: "d-1",
        endedAt: "2026-07-04T00:00:00.000Z",
      }, context),
    Error,
    "does not exist",
  );
});

Deno.test("pendingDispatchModel: enqueue without optional fields", async () => {
  const { context, store } = harness();
  await pendingDispatchModel.methods.enqueue.execute({
    queueId: "q-minimal",
    modelType: "command/shell",
    methodName: "execute",
    queuedAt: "2026-07-04T00:00:00.000Z",
  }, context);
  const record = store.get("pending-q-minimal")!;
  assertEquals(record.state, "waiting");
  assertEquals(record.target, undefined);
  assertEquals(record.labels, undefined);
  assertEquals(record.workflowName, undefined);
});

Deno.test("startPendingDispatch: records a waiting entry and refuses one that already exists", () => {
  assertEquals(startPendingDispatch(enqueueArgs, null), {
    ...enqueueArgs,
    state: "waiting",
  });
  assertThrows(
    () => startPendingDispatch(enqueueArgs, { queueId: "q-1" }),
    Error,
    "Pending dispatch 'q-1' already exists",
  );
});

Deno.test("parseStoredPendingDispatch: a missing record fails loudly, a stored one parses", () => {
  assertThrows(
    () => parseStoredPendingDispatch("nope", null),
    Error,
    "Pending dispatch 'nope' does not exist",
  );
  const waiting = startPendingDispatch(enqueueArgs, null);
  assertEquals(parseStoredPendingDispatch("q-1", { ...waiting }), waiting);
});

Deno.test("endedPendingDispatch: ends a waiting entry, and leaves a terminal one alone", () => {
  const waiting: PendingDispatch = startPendingDispatch(enqueueArgs, null);
  const endedAt = "2026-07-04T00:01:00.000Z";
  assertEquals(
    endedPendingDispatch(waiting, {
      state: "dispatched",
      dispatchId: "d-1",
      endedAt,
    }),
    { ...waiting, state: "dispatched", dispatchId: "d-1", endedAt },
  );
  assertEquals(
    endedPendingDispatch(waiting, { state: "timed_out", endedAt }),
    { ...waiting, state: "timed_out", endedAt },
  );
  for (const state of ["dispatched", "timed_out", "cancelled", "orphaned"]) {
    assertEquals(
      endedPendingDispatch(
        { ...waiting, state } as PendingDispatch,
        { state: "cancelled", endedAt },
      ),
      null,
    );
  }
});

Deno.test("PENDING_DISPATCH_END_METHODS: names the method for each end state", () => {
  assertEquals(PENDING_DISPATCH_END_METHODS, {
    dispatched: "mark_dispatched",
    timed_out: "timeout",
    cancelled: "cancel",
    orphaned: "orphan",
  });
  for (const method of Object.values(PENDING_DISPATCH_END_METHODS)) {
    assertEquals(method in pendingDispatchModel.methods, true);
  }
});

Deno.test("pendingDispatchModel: every method's outputs expire after a day", () => {
  for (const [name, method] of Object.entries(pendingDispatchModel.methods)) {
    assertEquals(method.outputLifetime, "1d", name);
  }
});

Deno.test("pendingDispatchModel: a __proto__ label key is stored the same way by enqueue and by an end transition", async () => {
  const { context, store } = harness();
  const labels: Record<string, string> = { gpu: "a100" };
  Object.defineProperty(labels, "__proto__", {
    value: "",
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const args = { ...enqueueArgs, labels };
  await pendingDispatchModel.methods.enqueue.execute(args, context);
  let expected = startPendingDispatch(args, null);
  assertEquals(store.get("pending-q-1"), expected);
  const end = {
    state: "timed_out" as const,
    endedAt: "2026-07-04T00:01:00.000Z",
  };
  await pendingDispatchModel.methods.timeout.execute(
    { queueId: "q-1", endedAt: end.endedAt },
    context,
  );
  expected = endedPendingDispatch(expected, end)!;
  assertEquals(store.get("pending-q-1"), expected);
  assertEquals(expected.labels?.gpu, "a100");
});
