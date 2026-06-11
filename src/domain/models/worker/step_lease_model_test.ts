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
import {
  STEP_LEASE_INSTANCE_NAME,
  STEP_LEASE_MODEL_TYPE,
  stepLeaseModel,
} from "./step_lease_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const acquireArgs = {
  leaseId: "l-1",
  dispatchId: "d-1",
  workerName: "ci-runner-3",
  modelType: "@acme/widget",
  modelId: "m-1",
  methodName: "create",
  workflowName: "deploy",
  stepName: "build",
};

function harness() {
  return createInMemoryWorkerContext(
    STEP_LEASE_MODEL_TYPE,
    STEP_LEASE_INSTANCE_NAME,
  );
}

Deno.test("stepLeaseModel: acquire records an active lease without writes", async () => {
  const { context, store } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  const lease = store.get("lease-l-1")!;
  assertEquals(lease.state, "active");
  assertEquals(lease.hasWrites, false);
  assertEquals(lease.workerName, "ci-runner-3");
});

Deno.test("stepLeaseModel: acquiring the same lease id twice fails", async () => {
  const { context } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await assertRejects(
    () => stepLeaseModel.methods.acquire.execute(acquireArgs, context),
    Error,
    "already exists",
  );
});

Deno.test("stepLeaseModel: leases are independent data items under one instance", async () => {
  const { context, store } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await stepLeaseModel.methods.acquire.execute(
    { ...acquireArgs, leaseId: "l-2", dispatchId: "d-2" },
    context,
  );
  assertEquals(store.has("lease-l-1"), true);
  assertEquals(store.has("lease-l-2"), true);
});

Deno.test("stepLeaseModel: mark_writes flips hasWrites once and is idempotent", async () => {
  const { context, store, versions } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await stepLeaseModel.methods.mark_writes.execute({ leaseId: "l-1" }, context);
  assertEquals(store.get("lease-l-1")!.hasWrites, true);
  const after = versions.get("lease-l-1");
  await stepLeaseModel.methods.mark_writes.execute({ leaseId: "l-1" }, context);
  assertEquals(versions.get("lease-l-1"), after);
});

Deno.test("stepLeaseModel: complete ends an active lease", async () => {
  const { context, store } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await stepLeaseModel.methods.complete.execute({ leaseId: "l-1" }, context);
  const lease = store.get("lease-l-1")!;
  assertEquals(lease.state, "completed");
  assertEquals(typeof lease.endedAt, "string");
});

Deno.test("stepLeaseModel: fail records the error", async () => {
  const { context, store } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await stepLeaseModel.methods.fail.execute(
    { leaseId: "l-1", error: "worker dropped mid-write" },
    context,
  );
  const lease = store.get("lease-l-1")!;
  assertEquals(lease.state, "failed");
  assertEquals(lease.error, "worker dropped mid-write");
});

Deno.test("stepLeaseModel: expire ends a lease after the grace window", async () => {
  const { context, store } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await stepLeaseModel.methods.expire.execute({ leaseId: "l-1" }, context);
  assertEquals(store.get("lease-l-1")!.state, "expired");
});

Deno.test("stepLeaseModel: ending a non-active lease fails", async () => {
  const { context } = harness();
  await stepLeaseModel.methods.acquire.execute(acquireArgs, context);
  await stepLeaseModel.methods.complete.execute({ leaseId: "l-1" }, context);
  await assertRejects(
    () => stepLeaseModel.methods.fail.execute({ leaseId: "l-1" }, context),
    Error,
    "already completed",
  );
});

Deno.test("stepLeaseModel: operations on unknown leases fail loudly", async () => {
  const { context } = harness();
  await assertRejects(
    () => stepLeaseModel.methods.complete.execute({ leaseId: "nope" }, context),
    Error,
    "does not exist",
  );
});
