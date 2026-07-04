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

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  type Binding,
  ENROLLMENT_TOKEN_MODEL_TYPE,
  enrollmentTokenModel,
  type MaxEnrollments,
  tokenSecretKey,
} from "./enrollment_token_model.ts";
import { timingSafeEqual } from "../../crypto/timing_safe_equal.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const mintArgs = {
  durationMs: 60_000,
  vaultName: "local",
  maxEnrollments: 1 as const,
};

function tokenBindings(
  store: Map<string, Record<string, unknown>>,
): Binding[] {
  return store.get("token-main")!.bindings as Binding[];
}

function tokenMaxEnrollments(
  store: Map<string, Record<string, unknown>>,
): MaxEnrollments {
  return store.get("token-main")!.maxEnrollments as MaxEnrollments;
}

async function mintToken(name = "ci-runner-3") {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    name,
  );
  await enrollmentTokenModel.methods.mint.execute(mintArgs, harness.context);
  const plaintext = harness.vault.get(`local/${tokenSecretKey(name)}`)!;
  return { ...harness, plaintext };
}

Deno.test("enrollmentTokenModel: mint writes the secret to the vault, never to data", async () => {
  const { store, plaintext } = await mintToken();
  const token = store.get("token-main")!;
  assertEquals(token.state, "unused");
  assertEquals(token.vaultName, "local");
  assertEquals(token.secretKey, tokenSecretKey("ci-runner-3"));
  assertEquals(tokenMaxEnrollments(store), 1);
  assertEquals(tokenBindings(store), []);
  assertEquals(typeof plaintext, "string");
  assertEquals(plaintext.length, 64);
  assertEquals(JSON.stringify(token).includes(plaintext), false);
});

Deno.test("enrollmentTokenModel: mint twice with the same name fails", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () => enrollmentTokenModel.methods.mint.execute(mintArgs, context),
    Error,
    "already exists",
  );
});

Deno.test("enrollmentTokenModel: redeem transitions unused → enrolled and binds the machine", async () => {
  const { context, store, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "machine-1" },
    context,
  );
  const token = store.get("token-main")!;
  assertEquals(token.state, "enrolled");
  const bindings = tokenBindings(store);
  assertEquals(bindings.length, 1);
  assertEquals(bindings[0].machineId, "machine-1");
  assertEquals(typeof bindings[0].enrolledAt, "string");
});

Deno.test("enrollmentTokenModel: redeem with a wrong token fails", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: "wrong", machineId: "machine-1" },
        context,
      ),
    Error,
    "does not match",
  );
});

Deno.test("enrollmentTokenModel: re-auth of the bound machine succeeds without a new version", async () => {
  const { context, versions, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "machine-1" },
    context,
  );
  const versionsAfterEnroll = versions.get("token-main");
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "machine-1" },
    context,
  );
  assertEquals(versions.get("token-main"), versionsAfterEnroll);
});

Deno.test("enrollmentTokenModel: a second machine cannot claim a single-enrollment token", async () => {
  const { context, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "machine-1" },
    context,
  );
  const error = await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "machine-2" },
        context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "allowance exhausted");
});

Deno.test("enrollmentTokenModel: redeem of an expired unused token fails", async () => {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    "stale",
  );
  await enrollmentTokenModel.methods.mint.execute(
    { durationMs: 1, vaultName: "local" },
    harness.context,
  );
  const plaintext = harness.vault.get(`local/${tokenSecretKey("stale")}`)!;
  await new Promise((r) => setTimeout(r, 5));
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "machine-1" },
        harness.context,
      ),
    Error,
    "expired",
  );
});

Deno.test("enrollmentTokenModel: even the bound machine cannot redeem past the token lifetime", async () => {
  const { context, store, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "machine-1" },
    context,
  );
  // The lifetime is a hard deadline: once it elapses, a rebooted worker on
  // the bound machine is rejected too and needs a freshly minted token.
  store.get("token-main")!.expiresAt = new Date(Date.now() - 1_000)
    .toISOString();
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "machine-1" },
        context,
      ),
    Error,
    "expired",
  );
});

Deno.test("enrollmentTokenModel: legacy record with boundMachineId migrates to bindings on read", async () => {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    "legacy",
  );
  // Simulate a legacy record with boundMachineId instead of bindings.
  const legacyRecord = {
    name: "legacy",
    state: "enrolled",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    vaultName: "local",
    secretKey: "worker-token-legacy",
    boundMachineId: "machine-1",
    enrolledAt: "2026-06-01T00:00:00.000Z",
  };
  harness.store.set("token-main", legacyRecord as Record<string, unknown>);
  harness.vault.set("local/worker-token-legacy", "test-secret");

  // Re-auth of the migrated machine should work.
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: "test-secret", machineId: "machine-1" },
    harness.context,
  );
  // The second machine is rejected (maxEnrollments defaults to 1).
  const error = await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: "test-secret", machineId: "machine-2" },
        harness.context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "allowance exhausted");
});

Deno.test("enrollmentTokenModel: revoke blocks subsequent redemption", async () => {
  const { context, plaintext, store } = await mintToken();
  await enrollmentTokenModel.methods.revoke.execute({}, context);
  assertEquals(store.get("token-main")!.state, "revoked");
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "machine-1" },
        context,
      ),
    Error,
    "revoked",
  );
});

Deno.test("enrollmentTokenModel: revoke is idempotent", async () => {
  const { context, versions } = await mintToken();
  await enrollmentTokenModel.methods.revoke.execute({}, context);
  const after = versions.get("token-main");
  await enrollmentTokenModel.methods.revoke.execute({}, context);
  assertEquals(versions.get("token-main"), after);
});

Deno.test("enrollmentTokenModel: expire records the lapsed lifetime", async () => {
  const { context, store } = await mintToken();
  await enrollmentTokenModel.methods.expire.execute({}, context);
  assertEquals(store.get("token-main")!.state, "expired");
});

Deno.test("enrollmentTokenModel: minted tokens are unique", async () => {
  const a = await mintToken("a");
  const b = await mintToken("b");
  assertNotEquals(a.plaintext, b.plaintext);
});

async function mintFleetToken(
  name = "pool",
  maxEnrollments: number | "unlimited" = 3,
) {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    name,
  );
  await enrollmentTokenModel.methods.mint.execute(
    { durationMs: 60_000, vaultName: "local", maxEnrollments },
    harness.context,
  );
  const plaintext = harness.vault.get(`local/${tokenSecretKey(name)}`)!;
  return { ...harness, plaintext };
}

Deno.test("enrollmentTokenModel: maxEnrollments: 3 allows three machines, rejects the fourth", async () => {
  const { context, store, plaintext } = await mintFleetToken("pool", 3);
  assertEquals(tokenMaxEnrollments(store), 3);

  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m2" },
    context,
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m3" },
    context,
  );
  assertEquals(tokenBindings(store).length, 3);

  const error = await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "m4" },
        context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "allowance exhausted");
});

Deno.test("enrollmentTokenModel: maxEnrollments: unlimited allows N machines", async () => {
  const { context, store, plaintext } = await mintFleetToken(
    "fleet",
    "unlimited",
  );
  assertEquals(tokenMaxEnrollments(store), "unlimited");

  for (let i = 0; i < 10; i++) {
    await enrollmentTokenModel.methods.redeem.execute(
      { presentedToken: plaintext, machineId: `m${i}` },
      context,
    );
  }
  assertEquals(tokenBindings(store).length, 10);
});

Deno.test("enrollmentTokenModel: re-auth of a known machine does not append a duplicate binding", async () => {
  const { context, store, plaintext, versions } = await mintFleetToken(
    "pool2",
    3,
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  const versionsAfterEnroll = versions.get("token-main");
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  assertEquals(versions.get("token-main"), versionsAfterEnroll);
  assertEquals(tokenBindings(store).length, 1);
});

Deno.test("enrollmentTokenModel: revoke disconnects all bindings", async () => {
  const { context, store, plaintext } = await mintFleetToken("pool3", 3);
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m2" },
    context,
  );
  await enrollmentTokenModel.methods.revoke.execute({}, context);
  assertEquals(store.get("token-main")!.state, "revoked");
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "m1" },
        context,
      ),
    Error,
    "revoked",
  );
});

Deno.test("timingSafeEqual: equal and unequal strings", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
  assertEquals(timingSafeEqual("", ""), true);
  assertEquals(timingSafeEqual("", "x"), false);
});
