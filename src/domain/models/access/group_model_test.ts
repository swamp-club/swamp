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
import { type Group, GROUP_MODEL_TYPE, groupModel } from "./group_model.ts";
import { createInMemoryAccessContext } from "./access_test_helpers.ts";

function createTestContext(instanceName = "release-managers") {
  return createInMemoryAccessContext(GROUP_MODEL_TYPE, instanceName);
}

Deno.test("create: creates a new empty group", async () => {
  const { context, store } = createTestContext();
  const result = await groupModel.methods.create.execute(
    { createdBy: "user:admin" },
    context,
  );
  assertEquals(result.dataHandles?.length, 1);
  const group = store.get("group-main") as unknown as Group;
  assertEquals(group.name, "release-managers");
  assertEquals(group.members, []);
  assertEquals(group.createdBy, { kind: "user", id: "admin" });
});

Deno.test("create: rejects duplicate group", async () => {
  const { context } = createTestContext();
  await groupModel.methods.create.execute({ createdBy: "user:admin" }, context);
  await assertRejects(
    () =>
      groupModel.methods.create.execute({ createdBy: "user:admin" }, context),
    Error,
    "already exists",
  );
});

Deno.test("add-member: adds a principal to the group", async () => {
  const { context, store } = createTestContext();
  await groupModel.methods.create.execute({ createdBy: "user:admin" }, context);
  const result = await groupModel.methods["add-member"].execute(
    { principal: "user:adam" },
    context,
  );
  assertEquals(result.dataHandles?.length, 1);
  const group = store.get("group-main") as unknown as Group;
  assertEquals(group.members, [{ kind: "user", id: "adam" }]);
});

Deno.test("add-member: is idempotent for existing member", async () => {
  const { context } = createTestContext();
  await groupModel.methods.create.execute({ createdBy: "user:admin" }, context);
  await groupModel.methods["add-member"].execute(
    { principal: "user:adam" },
    context,
  );
  const result = await groupModel.methods["add-member"].execute(
    { principal: "user:adam" },
    context,
  );
  assertEquals(result.dataHandles?.length, 0);
});

Deno.test("add-member: supports multiple members", async () => {
  const { context, store } = createTestContext();
  await groupModel.methods.create.execute({ createdBy: "user:admin" }, context);
  await groupModel.methods["add-member"].execute(
    { principal: "user:adam" },
    context,
  );
  await groupModel.methods["add-member"].execute(
    { principal: "user:eve" },
    context,
  );
  const group = store.get("group-main") as unknown as Group;
  assertEquals(group.members.length, 2);
});

Deno.test("add-member: rejects when group does not exist", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () =>
      groupModel.methods["add-member"].execute(
        { principal: "user:adam" },
        context,
      ),
    Error,
    "does not exist",
  );
});

Deno.test("remove-member: removes a principal from the group", async () => {
  const { context, store } = createTestContext();
  await groupModel.methods.create.execute({ createdBy: "user:admin" }, context);
  await groupModel.methods["add-member"].execute(
    { principal: "user:adam" },
    context,
  );
  await groupModel.methods["add-member"].execute(
    { principal: "user:eve" },
    context,
  );
  const result = await groupModel.methods["remove-member"].execute(
    { principal: "user:adam" },
    context,
  );
  assertEquals(result.dataHandles?.length, 1);
  const group = store.get("group-main") as unknown as Group;
  assertEquals(group.members, [{ kind: "user", id: "eve" }]);
});

Deno.test("remove-member: is a no-op for non-member", async () => {
  const { context } = createTestContext();
  await groupModel.methods.create.execute({ createdBy: "user:admin" }, context);
  const result = await groupModel.methods["remove-member"].execute(
    { principal: "user:nobody" },
    context,
  );
  assertEquals(result.dataHandles?.length, 0);
});

Deno.test("remove-member: rejects when group does not exist", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () =>
      groupModel.methods["remove-member"].execute(
        { principal: "user:adam" },
        context,
      ),
    Error,
    "does not exist",
  );
});

Deno.test("members: rejects when group does not exist", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () => groupModel.methods.members.execute({}, context),
    Error,
    "does not exist",
  );
});

Deno.test("create: preserves group name from instance name", async () => {
  const { context, store } = createTestContext("platform-team");
  await groupModel.methods.create.execute(
    { createdBy: "user:admin" },
    context,
  );
  const group = store.get("group-main") as unknown as Group;
  assertEquals(group.name, "platform-team");
});
