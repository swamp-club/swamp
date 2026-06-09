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
import { WORKER_MODEL_TYPE, workerModel } from "./worker_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const enrollArgs = {
  instanceUuid: "uuid-1",
  tokenName: "ci-runner-3",
  labels: { region: "us-east" },
  platform: "linux",
  arch: "x86_64",
  swampVersion: "1.0.0",
  protocolVersion: 1,
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
  assertEquals(state.currentDispatchId, null);
  assertEquals((state.labels as Record<string, string>).region, "us-east");
});

Deno.test("workerModel: set_status busy records the dispatch id", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  await workerModel.methods.set_status.execute(
    { status: "busy", dispatchId: "d-42" },
    context,
  );
  const state = store.get("state-main")!;
  assertEquals(state.status, "busy");
  assertEquals(state.currentDispatchId, "d-42");
});

Deno.test("workerModel: set_status idle clears the dispatch id", async () => {
  const { context, store } = createInMemoryWorkerContext(
    WORKER_MODEL_TYPE,
    "ci-runner-3",
  );
  await workerModel.methods.enroll.execute(enrollArgs, context);
  await workerModel.methods.set_status.execute(
    { status: "busy", dispatchId: "d-42" },
    context,
  );
  await workerModel.methods.set_status.execute({ status: "idle" }, context);
  const state = store.get("state-main")!;
  assertEquals(state.status, "idle");
  assertEquals(state.currentDispatchId, null);
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
