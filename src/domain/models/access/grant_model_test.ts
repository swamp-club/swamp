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
import { type Grant, GRANT_MODEL_TYPE, grantModel } from "./grant_model.ts";
import { createInMemoryAccessContext } from "./access_test_helpers.ts";
import { GrantSourceSchema } from "../../access/grant_source.ts";

function createTestContext(instanceName = "test-grant") {
  return createInMemoryAccessContext(GRANT_MODEL_TYPE, instanceName);
}

const VALID_CREATE_ARGS = {
  subject: "user:adam",
  effect: "allow" as const,
  actions: ["read" as const, "run" as const],
  resourceKind: "workflow",
  resourcePattern: "@acme/*",
  source: "method",
  createdBy: "user:admin",
};

Deno.test("create: creates a new grant", async () => {
  const { context, store } = createTestContext();
  const result = await grantModel.methods.create.execute(
    VALID_CREATE_ARGS,
    context,
  );
  assertEquals(result.dataHandles?.length, 1);
  const grant = store.get("grant-main") as unknown as Grant;
  assertEquals(grant.subject, { kind: "user", name: "adam" });
  assertEquals(grant.effect, "allow");
  assertEquals(grant.actions, ["read", "run"]);
  assertEquals(grant.resource, { kind: "workflow", pattern: "@acme/*" });
  assertEquals(grant.state, "active");
  assertEquals(grant.source, "method");
  assertEquals(grant.createdBy, { kind: "user", id: "admin" });
});

Deno.test("create: rejects duplicate grant", async () => {
  const { context } = createTestContext();
  await grantModel.methods.create.execute(VALID_CREATE_ARGS, context);
  await assertRejects(
    () => grantModel.methods.create.execute(VALID_CREATE_ARGS, context),
    Error,
    "already exists",
  );
});

Deno.test("create: stores valid condition as string", async () => {
  const { context, store } = createTestContext();
  await grantModel.methods.create.execute(
    {
      ...VALID_CREATE_ARGS,
      condition: 'tags.env == "staging"',
    },
    context,
  );
  const grant = store.get("grant-main") as unknown as Grant;
  assertEquals(grant.condition, 'tags.env == "staging"');
});

Deno.test("create: rejects invalid condition syntax", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () =>
      grantModel.methods.create.execute(
        { ...VALID_CREATE_ARGS, condition: "name ==" },
        context,
      ),
    Error,
    "Invalid grant condition",
  );
});

Deno.test("create: rejects condition with unknown field", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () =>
      grantModel.methods.create.execute(
        { ...VALID_CREATE_ARGS, condition: 'unknown_field == "value"' },
        context,
      ),
    Error,
    "Invalid grant condition",
  );
});

Deno.test("create: rejects condition exceeding length limit", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () =>
      grantModel.methods.create.execute(
        { ...VALID_CREATE_ARGS, condition: "a".repeat(1025) },
        context,
      ),
    Error,
    "maximum length",
  );
});

Deno.test("create: accepts extension source", async () => {
  const { context, store } = createTestContext();
  await grantModel.methods.create.execute(
    { ...VALID_CREATE_ARGS, source: "extension:my-ext" },
    context,
  );
  const grant = store.get("grant-main") as unknown as Grant;
  assertEquals(grant.source, "extension:my-ext");
});

Deno.test("create: accepts idp-group subject", async () => {
  const { context, store } = createTestContext();
  await grantModel.methods.create.execute(
    { ...VALID_CREATE_ARGS, subject: "idp-group:platform-eng" },
    context,
  );
  const grant = store.get("grant-main") as unknown as Grant;
  assertEquals(grant.subject, { kind: "idp-group", name: "platform-eng" });
});

Deno.test("revoke: transitions active to revoked", async () => {
  const { context, store } = createTestContext();
  await grantModel.methods.create.execute(VALID_CREATE_ARGS, context);
  const result = await grantModel.methods.revoke.execute({}, context);
  assertEquals(result.dataHandles?.length, 1);
  const grant = store.get("grant-main") as unknown as Grant;
  assertEquals(grant.state, "revoked");
});

Deno.test("revoke: is idempotent on already-revoked grant", async () => {
  const { context } = createTestContext();
  await grantModel.methods.create.execute(VALID_CREATE_ARGS, context);
  await grantModel.methods.revoke.execute({}, context);
  const result = await grantModel.methods.revoke.execute({}, context);
  assertEquals(result.dataHandles?.length, 0);
});

Deno.test("revoke: rejects when grant does not exist", async () => {
  const { context } = createTestContext();
  await assertRejects(
    () => grantModel.methods.revoke.execute({}, context),
    Error,
    "does not exist",
  );
});

Deno.test("revoke: preserves all fields except state", async () => {
  const { context, store } = createTestContext();
  await grantModel.methods.create.execute(VALID_CREATE_ARGS, context);
  const beforeRevoke = structuredClone(
    store.get("grant-main") as unknown as Grant,
  );
  await grantModel.methods.revoke.execute({}, context);
  const afterRevoke = store.get("grant-main") as unknown as Grant;
  assertEquals(afterRevoke.id, beforeRevoke.id);
  assertEquals(afterRevoke.subject, beforeRevoke.subject);
  assertEquals(afterRevoke.source, beforeRevoke.source);
  assertEquals(afterRevoke.createdBy, beforeRevoke.createdBy);
  assertEquals(afterRevoke.createdAt, beforeRevoke.createdAt);
  assertEquals(afterRevoke.state, "revoked");
});

Deno.test("create: schema rejects invalid source value", () => {
  const result = GrantSourceSchema.safeParse("invalid");
  assertEquals(result.success, false);
});

Deno.test("create: schema accepts valid source values", () => {
  for (
    const source of [
      "method",
      "config",
      "file:test.yaml",
      "extension:my-ext",
    ]
  ) {
    const result = GrantSourceSchema.safeParse(source);
    assertEquals(result.success, true, `Expected "${source}" to be valid`);
  }
});

Deno.test("create: source field is set at creation and persisted", async () => {
  const { context, store } = createTestContext();
  await grantModel.methods.create.execute(
    { ...VALID_CREATE_ARGS, source: "file:test.yaml" },
    context,
  );
  const grant = store.get("grant-main") as unknown as Grant;
  assertEquals(grant.source, "file:test.yaml");

  await grantModel.methods.revoke.execute({}, context);
  const revoked = store.get("grant-main") as unknown as Grant;
  assertEquals(revoked.source, "file:test.yaml");
});
