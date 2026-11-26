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
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  admitsMachine,
  type Binding,
  deliverablePredecessor,
  effectiveWorkerLabels,
  ENROLLMENT_TOKEN_MODEL_TYPE,
  enrollmentMintFor,
  type EnrollmentToken,
  enrollmentTokenBindingVerdict,
  enrollmentTokenClosed,
  enrollmentTokenModel,
  EnrollmentTokenSchema,
  LABEL_CONFLICT_PHRASE,
  LABEL_RESERVED_PHRASE,
  type MaxEnrollments,
  presentedTokenMint,
  rotatedTokenSecretKey,
  rotationCarryOverCapMs,
  tokenSecretKey,
  tokenSuppliedLabels,
  WORKER_ROTATED_TOKEN_SECRET_KEY_PREFIX,
  workerLabelRefusal,
} from "./enrollment_token_model.ts";
import { timingSafeEqual } from "../../crypto/timing_safe_equal.ts";
import { withoutQuotedNames } from "../../remote/protocol.ts";
import {
  advanceTokenClock,
  createInMemoryWorkerContext,
} from "./worker_test_helpers.ts";
import { resolveStaleness } from "../../definitions/definition_staleness.ts";
import { SecretNotFoundError } from "../../vaults/secret_not_found_error.ts";

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

const BASE_ENROLLED_AT = "2026-01-01T00:00:00.000Z";

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

Deno.test("enrollmentTokenModel: mint twice with the same name fails when active", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () => enrollmentTokenModel.methods.mint.execute(mintArgs, context),
    Error,
    "already exists",
  );
});

Deno.test("enrollmentTokenModel: mint after revoke succeeds with fresh credentials", async () => {
  const { context, store, vault, plaintext: oldPlaintext } = await mintToken();
  await enrollmentTokenModel.methods.revoke.execute({}, context);
  assertEquals(store.get("token-main")!.state, "revoked");
  await enrollmentTokenModel.methods.mint.execute(mintArgs, context);
  const token = store.get("token-main")!;
  assertEquals(token.state, "unused");
  const newPlaintext = vault.get(
    `local/${tokenSecretKey("ci-runner-3")}`,
  )!;
  assertNotEquals(newPlaintext, oldPlaintext);
});

Deno.test("enrollmentTokenModel: mint after expire succeeds with fresh credentials", async () => {
  const { context, store, vault, plaintext: oldPlaintext } = await mintToken();
  await enrollmentTokenModel.methods.expire.execute({}, context);
  assertEquals(store.get("token-main")!.state, "expired");
  await enrollmentTokenModel.methods.mint.execute(mintArgs, context);
  const token = store.get("token-main")!;
  assertEquals(token.state, "unused");
  const newPlaintext = vault.get(
    `local/${tokenSecretKey("ci-runner-3")}`,
  )!;
  assertNotEquals(newPlaintext, oldPlaintext);
});

Deno.test("enrollmentTokenModel: mint succeeds for unused token past its expiresAt without explicit expire", async () => {
  const { context, store, vault, plaintext: oldPlaintext } = await mintToken();
  assertEquals(store.get("token-main")!.state, "unused");
  store.get("token-main")!.expiresAt = new Date(Date.now() - 1_000)
    .toISOString();
  await enrollmentTokenModel.methods.mint.execute(mintArgs, context);
  const token = store.get("token-main")!;
  assertEquals(token.state, "unused");
  const newPlaintext = vault.get(
    `local/${tokenSecretKey("ci-runner-3")}`,
  )!;
  assertNotEquals(newPlaintext, oldPlaintext);
});

Deno.test("enrollmentTokenModel: mint succeeds for enrolled token past its expiresAt without explicit expire", async () => {
  const { context, store, vault, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "machine-1" },
    context,
  );
  assertEquals(store.get("token-main")!.state, "enrolled");
  const oldPlaintext = vault.get(
    `local/${tokenSecretKey("ci-runner-3")}`,
  )!;
  store.get("token-main")!.expiresAt = new Date(Date.now() - 1_000)
    .toISOString();
  await enrollmentTokenModel.methods.mint.execute(mintArgs, context);
  const token = store.get("token-main")!;
  assertEquals(token.state, "unused");
  const newPlaintext = vault.get(
    `local/${tokenSecretKey("ci-runner-3")}`,
  )!;
  assertNotEquals(newPlaintext, oldPlaintext);
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

  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: "test-secret", machineId: "machine-1" },
    harness.context,
  );
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

Deno.test("enrollmentTokenModel: prune_bindings removes specified machineIds", async () => {
  const { context, store, plaintext } = await mintFleetToken(
    "prune-test",
    "unlimited",
  );
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

  await enrollmentTokenModel.methods.prune_bindings.execute(
    { machineIds: ["m1", "m3"] },
    context,
  );
  const remaining = tokenBindings(store);
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0].machineId, "m2");
});

Deno.test("enrollmentTokenModel: prune_bindings with no matching ids is a no-op", async () => {
  const { context, store, plaintext, versions } = await mintFleetToken(
    "prune-noop",
    "unlimited",
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  const versionsAfterEnroll = versions.get("token-main");

  await enrollmentTokenModel.methods.prune_bindings.execute(
    { machineIds: ["nonexistent"] },
    context,
  );
  assertEquals(versions.get("token-main"), versionsAfterEnroll);
  assertEquals(tokenBindings(store).length, 1);
});

Deno.test("enrollmentTokenModel: prune_bindings removes all bindings when all match", async () => {
  const { context, store, plaintext } = await mintFleetToken(
    "prune-all",
    "unlimited",
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m2" },
    context,
  );

  await enrollmentTokenModel.methods.prune_bindings.execute(
    { machineIds: ["m1", "m2"] },
    context,
  );
  assertEquals(tokenBindings(store).length, 0);
});

Deno.test("enrollmentTokenModel: prune_bindings rejects on unused token", async () => {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    "prune-unused",
  );
  await enrollmentTokenModel.methods.mint.execute(mintArgs, harness.context);

  await assertRejects(
    () =>
      enrollmentTokenModel.methods.prune_bindings.execute(
        { machineIds: ["m1"] },
        harness.context,
      ),
    Error,
    "unused",
  );
});

Deno.test("enrollmentTokenModel: prune_bindings works on revoked token", async () => {
  const { context, store, plaintext } = await mintFleetToken(
    "prune-revoked",
    "unlimited",
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  await enrollmentTokenModel.methods.revoke.execute({}, context);

  await enrollmentTokenModel.methods.prune_bindings.execute(
    { machineIds: ["m1"] },
    context,
  );
  assertEquals(tokenBindings(store).length, 0);
});

Deno.test("enrollmentTokenModel: prune_bindings frees enrollment slots on capped token", async () => {
  const { context, store, plaintext } = await mintFleetToken("prune-cap", 2);
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m1" },
    context,
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m2" },
    context,
  );
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, machineId: "m3" },
        context,
      ),
    Error,
    "allowance exhausted",
  );

  await enrollmentTokenModel.methods.prune_bindings.execute(
    { machineIds: ["m1"] },
    context,
  );
  assertEquals(tokenBindings(store).length, 1);

  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, machineId: "m3" },
    context,
  );
  assertEquals(tokenBindings(store).length, 2);
});

async function rotateToken(
  harness: Awaited<ReturnType<typeof mintToken>>,
  args: { durationMs?: number } = {},
) {
  await enrollmentTokenModel.methods.rotate.execute(args, harness.context);
  const token = harness.store.get("token-main")!;
  const successor = harness.vault.get(`local/${token.secretKey as string}`)!;
  return { token, successor };
}

Deno.test("enrollmentTokenModel: rotate keeps the name and bindings and writes a fresh key", async () => {
  const harness = await mintToken();
  const before = harness.store.get("token-main")!;
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: harness.plaintext, machineId: "machine-1" },
    harness.context,
  );
  const { token, successor } = await rotateToken(harness);

  assertEquals(token.name, "ci-runner-3");
  assertEquals(token.state, "enrolled");
  assertEquals(
    token.secretKey,
    rotatedTokenSecretKey("ci-runner-3", Date.parse(token.createdAt as string)),
  );
  assertNotEquals(successor, harness.plaintext);
  assertEquals(
    harness.vault.get(`local/${tokenSecretKey("ci-runner-3")}`),
    harness.plaintext,
  );
  assertEquals(
    Date.parse(token.createdAt as string) >
      Date.parse(before.createdAt as string),
    true,
  );
  const predecessor = token.predecessor as Record<string, string>;
  assertEquals(predecessor.createdAt, before.createdAt);
  assertEquals(predecessor.expiresAt, before.expiresAt);
  assertEquals(predecessor.secretKey, tokenSecretKey("ci-runner-3"));
  const bindings = tokenBindings(harness.store);
  assertEquals(bindings.length, 1);
  assertEquals(bindings[0].mint, before.createdAt);
  assertEquals(JSON.stringify(token).includes(successor), false);
});

Deno.test("enrollmentTokenModel: rotate without a duration carries over the old secret's remaining time, up to the cap", async () => {
  const harness = await mintToken();
  const { token } = await rotateToken(harness);
  assertEquals(
    Date.parse(token.expiresAt as string) -
      Date.parse(token.createdAt as string),
    mintArgs.durationMs + rotationCarryOverCapMs(mintArgs.durationMs),
  );
  assertEquals(token.lifetimeMs, mintArgs.durationMs);
});

Deno.test("enrollmentTokenModel: rotate without a duration carries over all of a short remaining time", async () => {
  const harness = await mintToken();
  advanceTokenClock(harness.store, mintArgs.durationMs - 10_000);
  const before = EnrollmentTokenSchema.parse(harness.store.get("token-main"));
  const { token } = await rotateToken(harness);
  assertEquals(
    Date.parse(token.expiresAt as string),
    Date.parse(before.expiresAt) + mintArgs.durationMs,
  );
});

Deno.test("rotationCarryOverCapMs: a tenth of the lifetime, at least 40 s, never more than the lifetime", () => {
  assertEquals(rotationCarryOverCapMs(7 * 24 * 3_600_000), 7 * 24 * 360_000);
  assertEquals(rotationCarryOverCapMs(60_000), 40_000);
  assertEquals(rotationCarryOverCapMs(10_000), 10_000);
});

Deno.test("enrollmentTokenModel: rotate with a duration counts it from now and keeps it as the lifetime", async () => {
  const harness = await mintToken();
  const { token } = await rotateToken(harness, { durationMs: 5 * 60_000 });
  assertEquals(
    Date.parse(token.expiresAt as string) -
      Date.parse(token.createdAt as string),
    5 * 60_000,
  );
  assertEquals(token.lifetimeMs, 5 * 60_000);
});

Deno.test("enrollmentTokenModel: a shorter rotation clamps the predecessor's deadline", async () => {
  const harness = await mintToken();
  const { token } = await rotateToken(harness, { durationMs: 1_000 });
  const predecessor = token.predecessor as Record<string, string>;
  assertEquals(predecessor.expiresAt, token.expiresAt);
});

Deno.test("enrollmentTokenModel: both secrets redeem during the overlap and the binding records which", async () => {
  const harness = await mintToken();
  const { token, successor } = await rotateToken(harness);

  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: harness.plaintext, machineId: "machine-1" },
    harness.context,
  );
  const predecessor = token.predecessor as Record<string, string>;
  assertEquals(
    enrollmentMintFor(
      EnrollmentTokenSchema.parse(harness.store.get("token-main")),
      "machine-1",
    ),
    { createdAt: predecessor.createdAt, expiresAt: predecessor.expiresAt },
  );

  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: successor, machineId: "machine-1" },
    harness.context,
  );
  assertEquals(
    enrollmentMintFor(
      EnrollmentTokenSchema.parse(harness.store.get("token-main")),
      "machine-1",
    ),
    {
      createdAt: token.createdAt as string,
      expiresAt: token.expiresAt as string,
    },
  );
  assertEquals(tokenBindings(harness.store).length, 1);
});

Deno.test("enrollmentTokenModel: re-auth on the same mint after rotation writes nothing", async () => {
  const harness = await mintToken();
  const { successor } = await rotateToken(harness);
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: successor, machineId: "machine-1" },
    harness.context,
  );
  const versionsAfter = harness.versions.get("token-main");
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: successor, machineId: "machine-1" },
    harness.context,
  );
  assertEquals(harness.versions.get("token-main"), versionsAfter);
});

Deno.test("enrollmentTokenModel: the predecessor secret stops redeeming past its deadline", async () => {
  const harness = await mintToken();
  await rotateToken(harness);
  const record = harness.store.get("token-main")!;
  (record.predecessor as Record<string, string>).expiresAt = new Date(
    Date.now() - 1_000,
  ).toISOString();
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: harness.plaintext, machineId: "machine-1" },
        harness.context,
      ),
    Error,
    "does not match",
  );
});

Deno.test("enrollmentTokenModel: a second rotation retires the oldest secret and deletes its key", async () => {
  const harness = await mintToken();
  const first = await rotateToken(harness);
  const second = await rotateToken(harness);

  assertEquals(
    harness.vault.has(`local/${tokenSecretKey("ci-runner-3")}`),
    false,
  );
  assertEquals(
    (second.token.predecessor as Record<string, string>).secretKey,
    first.token.secretKey,
  );
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: harness.plaintext, machineId: "machine-1" },
        harness.context,
      ),
    Error,
    "does not match",
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: first.successor, machineId: "machine-1" },
    harness.context,
  );
});

Deno.test("enrollmentTokenModel: a failed record write leaves the old secret and record usable", async () => {
  const harness = await mintToken();
  const before = structuredClone(harness.store.get("token-main"));
  const failing = {
    ...harness.context,
    writeResource: () => Promise.reject(new Error("datastore unavailable")),
  };
  await assertRejects(
    () => enrollmentTokenModel.methods.rotate.execute({}, failing),
    Error,
    "datastore unavailable",
  );
  assertEquals(harness.store.get("token-main"), before);
  assertEquals(
    [...harness.vault.keys()].filter((k) =>
      k.includes(WORKER_ROTATED_TOKEN_SECRET_KEY_PREFIX)
    ),
    [],
  );
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: harness.plaintext, machineId: "machine-1" },
    harness.context,
  );
});

Deno.test("enrollmentTokenModel: the current secret still redeems when the predecessor's key is gone", async () => {
  const harness = await mintToken();
  const { successor } = await rotateToken(harness);
  harness.vault.delete(`local/${tokenSecretKey("ci-runner-3")}`);
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: successor, machineId: "machine-1" },
    harness.context,
  );
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: "wrong", machineId: "machine-2" },
        harness.context,
      ),
    Error,
    "does not match",
  );
});

Deno.test("enrollmentTokenModel: a vault failure reading the old secret stays retryable, never a mismatch", async () => {
  const harness = await mintToken();
  await rotateToken(harness);
  const failing = {
    ...harness.context,
    vaultService: {
      ...harness.context.vaultService!,
      get: (vaultName: string, secretKey: string) =>
        secretKey === tokenSecretKey("ci-runner-3")
          ? Promise.reject(new Error("vault timed out"))
          : harness.context.vaultService!.get(vaultName, secretKey),
    },
  } as typeof harness.context;
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: harness.plaintext, machineId: "machine-1" },
        failing,
      ),
    Error,
    "vault timed out",
  );
});

Deno.test("enrollmentTokenModel: re-minting a rotated token deletes its per-mint keys", async () => {
  const harness = await mintToken();
  const first = await rotateToken(harness);
  const second = await rotateToken(harness);
  await enrollmentTokenModel.methods.revoke.execute({}, harness.context);
  await enrollmentTokenModel.methods.mint.execute(mintArgs, harness.context);

  assertEquals(
    harness.vault.has(`local/${first.token.secretKey as string}`),
    false,
  );
  assertEquals(
    harness.vault.has(`local/${second.token.secretKey as string}`),
    false,
  );
  assertEquals(
    harness.vault.has(`local/${tokenSecretKey("ci-runner-3")}`),
    true,
  );
});

Deno.test("enrollmentTokenModel: rotate refuses a revoked token", async () => {
  const harness = await mintToken();
  await enrollmentTokenModel.methods.revoke.execute({}, harness.context);
  const error = await assertRejects(
    () => enrollmentTokenModel.methods.rotate.execute({}, harness.context),
    Error,
    "revoked",
  );
  assertStringIncludes(error.message, "swamp worker token create");
});

Deno.test("enrollmentTokenModel: rotate refuses an expired token", async () => {
  const harness = await mintToken();
  harness.store.get("token-main")!.expiresAt = new Date(Date.now() - 1_000)
    .toISOString();
  await assertRejects(
    () => enrollmentTokenModel.methods.rotate.execute({}, harness.context),
    Error,
    "expired",
  );
});

async function rotatedWithBindings(bindings: Binding[]) {
  const harness = await mintToken();
  const first = harness.store.get("token-main")!.createdAt as string;
  harness.store.get("token-main")!.bindings = bindings;
  const { token } = await rotateToken(harness);
  return { harness, first, current: token.createdAt as string };
}

function rebindTo(
  harness: Awaited<ReturnType<typeof mintToken>>,
  machineIds: string[],
  mint: string,
) {
  return enrollmentTokenModel.methods.rebind.execute(
    { machineIds, mint },
    harness.context,
  );
}

Deno.test("enrollmentTokenModel: rebind moves bound machines to the mint they saved in one write", async () => {
  const { harness, first, current } = await rotatedWithBindings([
    { machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT },
    { machineId: "machine-2", enrolledAt: BASE_ENROLLED_AT },
    { machineId: "machine-3", enrolledAt: BASE_ENROLLED_AT },
  ]);

  const result = await rebindTo(harness, ["machine-1", "machine-2"], current);

  assertEquals(result.dataHandles?.length, 1);
  assertEquals(
    tokenBindings(harness.store).map((b) => [b.machineId, b.mint]),
    [["machine-1", current], ["machine-2", current], ["machine-3", first]],
  );
});

Deno.test("enrollmentTokenModel: rebind skips a machine with no binding", async () => {
  const { harness, current } = await rotatedWithBindings([
    { machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT },
  ]);

  const result = await rebindTo(harness, ["machine-gone"], current);

  assertEquals(result.dataHandles, []);
});

Deno.test("enrollmentTokenModel: rebind ignores a mint that is neither current nor the predecessor", async () => {
  const { harness, first } = await rotatedWithBindings([
    { machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT },
  ]);
  const retired = new Date(Date.parse(first) - 1_000).toISOString();
  harness.store.get("token-main")!.bindings = [
    { machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT, mint: retired },
  ];
  const unknown = new Date(Date.parse(first) - 500).toISOString();

  const result = await rebindTo(harness, ["machine-1"], unknown);

  assertEquals(result.dataHandles, []);
  assertEquals(tokenBindings(harness.store)[0].mint, retired);
});

Deno.test("enrollmentTokenModel: rebind never moves a binding back to an older mint", async () => {
  const { harness, first, current } = await rotatedWithBindings([
    { machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT },
  ]);
  await rebindTo(harness, ["machine-1"], current);

  const result = await rebindTo(harness, ["machine-1"], first);

  assertEquals(result.dataHandles, []);
  assertEquals(tokenBindings(harness.store)[0].mint, current);
});

Deno.test("enrollmentTokenModel: rebind writes nothing for a binding already on the current mint", async () => {
  const harness = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: harness.plaintext, machineId: "machine-1" },
    harness.context,
  );
  const current = harness.store.get("token-main")!.createdAt as string;

  const result = await rebindTo(harness, ["machine-1"], current);

  assertEquals(result.dataHandles, []);
  assertEquals(tokenBindings(harness.store)[0].mint, undefined);
});

Deno.test("enrollmentTokenModel: rebind leaves a revoked or expired token alone", async () => {
  for (const end of ["revoked", "expired"] as const) {
    const { harness, first, current } = await rotatedWithBindings([
      { machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT },
    ]);
    if (end === "revoked") {
      await enrollmentTokenModel.methods.revoke.execute({}, harness.context);
    } else {
      harness.store.get("token-main")!.expiresAt = new Date(Date.now() - 1_000)
        .toISOString();
    }

    const result = await rebindTo(harness, ["machine-1"], current);

    assertEquals(result.dataHandles, [], end);
    assertEquals(tokenBindings(harness.store)[0].mint, first, end);
  }
});

Deno.test("enrollmentTokenModel: expiring the predecessor's mint clears it and keeps the token live", async () => {
  const harness = await mintToken();
  const before = harness.store.get("token-main")!;
  const { token } = await rotateToken(harness);
  await enrollmentTokenModel.methods.expire.execute(
    { mint: before.createdAt as string },
    harness.context,
  );
  const after = harness.store.get("token-main")!;
  assertEquals(after.predecessor, undefined);
  assertEquals(after.state, token.state);
  assertEquals(after.createdAt, token.createdAt);
  assertEquals(
    harness.vault.has(`local/${tokenSecretKey("ci-runner-3")}`),
    false,
  );
});

Deno.test("enrollmentTokenModel: expiring an unknown mint is a no-op", async () => {
  const harness = await mintToken();
  const versionsBefore = harness.versions.get("token-main");
  await enrollmentTokenModel.methods.expire.execute(
    { mint: "2020-01-01T00:00:00.000Z" },
    harness.context,
  );
  assertEquals(harness.versions.get("token-main"), versionsBefore);
  assertEquals(harness.store.get("token-main")!.state, "unused");
});

Deno.test("enrollmentTokenModel: expiring the current mint by name still expires the token", async () => {
  const harness = await mintToken();
  const { token } = await rotateToken(harness);
  await enrollmentTokenModel.methods.expire.execute(
    { mint: token.createdAt as string },
    harness.context,
  );
  assertEquals(harness.store.get("token-main")!.state, "expired");
});

function tokenRecord(overrides: Partial<EnrollmentToken>): EnrollmentToken {
  return {
    name: "ci-runner-3",
    state: "enrolled",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    vaultName: "local",
    secretKey: tokenSecretKey("ci-runner-3"),
    maxEnrollments: 1,
    bindings: [],
    ...overrides,
  };
}

Deno.test("enrollmentTokenBindingVerdict: keeps a worker on its own live mint", () => {
  const token = tokenRecord({});
  assertEquals(
    enrollmentTokenBindingVerdict(token, token.createdAt),
    { keep: true },
  );
});

Deno.test("enrollmentTokenBindingVerdict: a revoked token cuts the worker off", () => {
  const token = tokenRecord({ state: "revoked" });
  assertEquals(
    enrollmentTokenBindingVerdict(token, token.createdAt),
    { keep: false, cause: "revoked" },
  );
});

Deno.test("enrollmentTokenBindingVerdict: a re-minted name cuts off workers on the old mint", () => {
  const token = tokenRecord({
    state: "unused",
    createdAt: "2026-01-01T00:05:00.000Z",
  });
  assertEquals(
    enrollmentTokenBindingVerdict(token, "2026-01-01T00:00:00.000Z"),
    { keep: false, cause: "reminted" },
  );
});

Deno.test("enrollmentTokenBindingVerdict: an older record is a stale read, not a re-mint", () => {
  const token = tokenRecord({ createdAt: "2026-01-01T00:00:00.000Z" });
  assertEquals(
    enrollmentTokenBindingVerdict(token, "2026-01-01T00:05:00.000Z"),
    { keep: true },
  );
});

Deno.test("enrollmentTokenBindingVerdict: a rotation keeps workers on the predecessor until its deadline", () => {
  const token = tokenRecord({
    createdAt: "2026-01-01T00:05:00.000Z",
    predecessor: {
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
      secretKey: tokenSecretKey("ci-runner-3"),
    },
  });
  const beforeDeadline = Date.parse("2026-01-01T00:30:00.000Z");
  assertEquals(
    enrollmentTokenBindingVerdict(
      token,
      "2026-01-01T00:00:00.000Z",
      beforeDeadline,
    ),
    { keep: true },
  );
  assertEquals(
    enrollmentTokenBindingVerdict(
      token,
      "2026-01-01T00:00:00.000Z",
      Date.parse("2026-01-01T01:00:00.000Z"),
    ),
    { keep: false, cause: "expired" },
  );
  assertEquals(
    enrollmentTokenBindingVerdict(
      token,
      "2025-12-31T23:00:00.000Z",
      beforeDeadline,
    ),
    { keep: false, cause: "retired" },
  );
});

Deno.test("enrollmentTokenBindingVerdict: a missing record cuts the worker off", () => {
  assertEquals(
    enrollmentTokenBindingVerdict(null, "2026-01-01T00:00:00.000Z"),
    { keep: false, cause: "deleted" },
  );
});

Deno.test("timingSafeEqual: equal and unequal strings", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
  assertEquals(timingSafeEqual("", ""), true);
  assertEquals(timingSafeEqual("", "x"), false);
});

Deno.test("enrollmentTokenModel: a definition minted before rotation existed is upgradable, not stranded", () => {
  const upgrades = enrollmentTokenModel.upgrades ?? [];
  assertEquals(
    resolveStaleness(
      "2026.07.04.1",
      enrollmentTokenModel.version,
      upgrades.map((u) => u.toVersion),
    ).state,
    "upgradable",
  );
  assertEquals(upgrades.at(-1)?.upgradeAttributes({}), {});
});

Deno.test("rotatedTokenSecretKey: carries no dot and never collides with a token's own key", () => {
  const key = rotatedTokenSecretKey("web-01", 1_767_225_600_000);
  assertEquals(key, "worker-rotated-token-web-01-1767225600000");
  assertEquals(key.includes("."), false);
  assertEquals(key.startsWith(tokenSecretKey("")), false);
});

Deno.test("deliverablePredecessor: only a live rotation of a live token has a mint to deliver to", () => {
  const now = Date.parse("2026-01-01T00:30:00.000Z");
  const predecessor = {
    createdAt: "2025-12-31T23:00:00.000Z",
    expiresAt: "2026-01-01T00:45:00.000Z",
    secretKey: tokenSecretKey("ci-runner-3"),
  };
  assertEquals(
    deliverablePredecessor(tokenRecord({ predecessor }), now),
    predecessor,
  );
  assertEquals(deliverablePredecessor(tokenRecord({}), now), undefined);
  assertEquals(
    deliverablePredecessor(
      tokenRecord({
        predecessor: { ...predecessor, expiresAt: "2026-01-01T00:15:00.000Z" },
      }),
      now,
    ),
    undefined,
  );
  for (const state of ["revoked", "expired"] as const) {
    assertEquals(
      deliverablePredecessor(tokenRecord({ predecessor, state }), now),
      undefined,
      state,
    );
  }
  assertEquals(
    deliverablePredecessor(
      tokenRecord({ predecessor, expiresAt: "2026-01-01T00:20:00.000Z" }),
      now,
    ),
    undefined,
  );
});

Deno.test("enrollmentTokenModel: repeated default rotations keep the lifetime the token was minted with", async () => {
  const harness = await mintToken();
  for (let i = 0; i < 5; i++) {
    advanceTokenClock(harness.store, 50_000);
    const { token } = await rotateToken(harness);
    assertEquals(token.lifetimeMs, mintArgs.durationMs);
    assert(
      Date.parse(token.expiresAt as string) -
          Date.parse(token.createdAt as string) <=
        mintArgs.durationMs + rotationCarryOverCapMs(mintArgs.durationMs),
    );
  }
});

Deno.test("enrollmentTokenModel: a record minted before lifetimeMs rotates by its own span", async () => {
  const harness = await mintToken();
  const { lifetimeMs: _dropped, ...legacy } = EnrollmentTokenSchema.parse(
    harness.store.get("token-main"),
  );
  harness.store.set("token-main", legacy);
  const { token } = await rotateToken(harness);
  const span = Date.parse(legacy.expiresAt) - Date.parse(legacy.createdAt);
  assertEquals(
    Date.parse(token.expiresAt as string) -
      Date.parse(token.createdAt as string),
    span + rotationCarryOverCapMs(span),
  );
  assertEquals(token.lifetimeMs, span);
});

Deno.test("enrollmentTokenModel: a rotation close to the old deadline warns, one with time to spare does not", async () => {
  for (
    const [label, advanceMs, warns] of [
      ["10s left", mintArgs.durationMs - 10_000, true],
      ["50s left", mintArgs.durationMs - 50_000, false],
    ] as const
  ) {
    const harness = await mintToken();
    const warnings: string[] = [];
    const logger = Object.create(harness.context.logger);
    logger.warn = (message: string) => warnings.push(message);
    harness.context.logger = logger;
    advanceTokenClock(harness.store, advanceMs);

    await rotateToken(harness);

    assertEquals(
      warnings.some((w) => w.includes("before its old secret expires")),
      warns,
      label,
    );
  }
});

const OPEN_AT = Date.parse("2026-01-01T00:30:00.000Z");

function secretsReader(
  secrets: Record<string, string>,
): (secretKey: string) => Promise<string> {
  return (secretKey) =>
    secretKey in secrets
      ? Promise.resolve(secrets[secretKey])
      : Promise.reject(new SecretNotFoundError("local", secretKey));
}

const rotatedToken = tokenRecord({
  createdAt: "2026-01-01T00:20:00.000Z",
  secretKey: "worker-token-ci-runner-3-new",
  predecessor: {
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:45:00.000Z",
    secretKey: "worker-token-ci-runner-3-old",
  },
});

Deno.test("enrollmentTokenClosed: names a revoked or expired token and leaves an open one", () => {
  assertEquals(enrollmentTokenClosed(tokenRecord({}), OPEN_AT), null);
  assertEquals(
    enrollmentTokenClosed(tokenRecord({ state: "revoked" }), OPEN_AT),
    "revoked",
  );
  assertEquals(
    enrollmentTokenClosed(tokenRecord({ state: "expired" }), OPEN_AT),
    "expired",
  );
  assertEquals(
    enrollmentTokenClosed(
      tokenRecord({}),
      Date.parse("2026-01-01T01:00:00.000Z"),
    ),
    "expired",
  );
});

Deno.test("presentedTokenMint: the current secret opens the current mint", async () => {
  const opened = await presentedTokenMint(
    rotatedToken,
    "new-secret",
    OPEN_AT,
    secretsReader({
      "worker-token-ci-runner-3-new": "new-secret",
      "worker-token-ci-runner-3-old": "old-secret",
    }),
  );
  assertEquals(opened, { mint: rotatedToken.createdAt, current: true });
});

Deno.test("presentedTokenMint: a live predecessor's secret opens the predecessor mint", async () => {
  const opened = await presentedTokenMint(
    rotatedToken,
    "old-secret",
    OPEN_AT,
    secretsReader({
      "worker-token-ci-runner-3-new": "new-secret",
      "worker-token-ci-runner-3-old": "old-secret",
    }),
  );
  assertEquals(opened, {
    mint: rotatedToken.predecessor!.createdAt,
    current: false,
  });
});

Deno.test("presentedTokenMint: a lapsed predecessor, a deleted predecessor key or a wrong secret opens nothing", async () => {
  const both = {
    "worker-token-ci-runner-3-new": "new-secret",
    "worker-token-ci-runner-3-old": "old-secret",
  };
  assertEquals(
    await presentedTokenMint(
      rotatedToken,
      "old-secret",
      Date.parse("2026-01-01T00:50:00.000Z"),
      secretsReader(both),
    ),
    null,
  );
  assertEquals(
    await presentedTokenMint(
      rotatedToken,
      "old-secret",
      OPEN_AT,
      secretsReader({ "worker-token-ci-runner-3-new": "new-secret" }),
    ),
    null,
  );
  assertEquals(
    await presentedTokenMint(
      rotatedToken,
      "guess",
      OPEN_AT,
      secretsReader(both),
    ),
    null,
  );
});

Deno.test("presentedTokenMint: a failed read other than a missing predecessor key propagates", async () => {
  await assertRejects(() =>
    presentedTokenMint(
      rotatedToken,
      "new-secret",
      OPEN_AT,
      secretsReader({}),
    ), SecretNotFoundError);
  await assertRejects(
    () =>
      presentedTokenMint(
        rotatedToken,
        "old-secret",
        OPEN_AT,
        (secretKey) =>
          secretKey === "worker-token-ci-runner-3-new"
            ? Promise.resolve("new-secret")
            : Promise.reject(new Error("vault unreachable")),
      ),
    Error,
    "vault unreachable",
  );
});

Deno.test("admitsMachine: a bound machine always, a new one only while a slot is free", () => {
  const bound = tokenRecord({
    maxEnrollments: 1,
    bindings: [{ machineId: "machine-1", enrolledAt: BASE_ENROLLED_AT }],
  });
  assertEquals(admitsMachine(bound, "machine-1"), true);
  assertEquals(admitsMachine(bound, "machine-2"), false);
  assertEquals(admitsMachine(tokenRecord({ maxEnrollments: 2 }), "m"), true);
  assertEquals(
    admitsMachine(
      tokenRecord({ ...bound, maxEnrollments: "unlimited" }),
      "machine-2",
    ),
    true,
  );
});

async function mintLabelledToken(
  labels: Record<string, string>,
  maxEnrollments: number | "unlimited" = 1,
  name = "fleet-b",
) {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    name,
  );
  await enrollmentTokenModel.methods.mint.execute(
    { durationMs: 60_000, vaultName: "local", maxEnrollments, labels },
    harness.context,
  );
  const plaintext = harness.vault.get(`local/${tokenSecretKey(name)}`)!;
  return { ...harness, plaintext };
}

Deno.test("enrollmentTokenModel: mint records the bound labels", async () => {
  const { store } = await mintLabelledToken({ fleet: "b", region: "eu" });
  assertEquals(store.get("token-main")!.labels, { fleet: "b", region: "eu" });
});

Deno.test("enrollmentTokenModel: mint arguments refuse malformed labels", () => {
  const args = enrollmentTokenModel.methods.mint.arguments;
  for (
    const labels of [{ "": "x" }, { "a=b": "x" }, { fleet: "" }]
  ) {
    assertEquals(
      args.safeParse({ durationMs: 1000, vaultName: "local", labels }).success,
      false,
      JSON.stringify(labels),
    );
  }
  // JSON.parse makes __proto__ an own key, as a serve request or method input does
  assertEquals(
    args.safeParse({
      durationMs: 1000,
      vaultName: "local",
      labels: JSON.parse('{"__proto__": "x"}'),
    }).success,
    false,
  );
  assertEquals(
    args.safeParse({
      durationMs: 1000,
      vaultName: "local",
      labels: { constructor: "x" },
    }).success,
    true,
  );
  const parsed = args.parse({ durationMs: 1000, vaultName: "local" }) as {
    labels: Record<string, string>;
  };
  assertEquals(parsed.labels, {});
});

Deno.test("enrollmentTokenModel: a record minted before bound labels parses with none", () => {
  const record = EnrollmentTokenSchema.parse({
    name: "old",
    state: "unused",
    createdAt: BASE_ENROLLED_AT,
    expiresAt: "2026-01-02T00:00:00.000Z",
    vaultName: "local",
    secretKey: tokenSecretKey("old"),
  });
  assertEquals(record.labels, undefined);
  assertEquals(tokenSuppliedLabels(record), {});
});

Deno.test("enrollmentTokenModel: redeem refuses a worker that overrides a bound label and binds nothing", async () => {
  const { context, store, versions, plaintext } = await mintLabelledToken({
    fleet: "b",
  });
  const versionsBefore = versions.get("token-main");
  const error = await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        {
          presentedToken: plaintext,
          machineId: "machine-1",
          offeredLabels: { fleet: "a" },
          reservedLabelKeys: [],
        },
        context,
      ),
    Error,
  );
  assertStringIncludes(error.message, LABEL_CONFLICT_PHRASE);
  assertStringIncludes(error.message, "'fleet'");
  assertEquals(tokenBindings(store), []);
  assertEquals(store.get("token-main")!.state, "unused");
  assertEquals(versions.get("token-main"), versionsBefore);
});

Deno.test("enrollmentTokenModel: redeem accepts the bound value, an absent key and unrelated labels", async () => {
  const { context, store, plaintext } = await mintLabelledToken(
    { fleet: "b" },
    3,
  );
  for (
    const [machineId, offeredLabels] of [
      ["machine-1", { fleet: "b" }],
      ["machine-2", {}],
      ["machine-3", { gpu: "true" }],
    ] as const
  ) {
    await enrollmentTokenModel.methods.redeem.execute(
      {
        presentedToken: plaintext,
        machineId,
        offeredLabels,
        reservedLabelKeys: ["fleet"],
      },
      context,
    );
  }
  assertEquals(tokenBindings(store).length, 3);
});

Deno.test("enrollmentTokenModel: a bound machine that reconnects with an overriding label is refused", async () => {
  const { context, plaintext } = await mintLabelledToken({ fleet: "b" });
  await enrollmentTokenModel.methods.redeem.execute(
    {
      presentedToken: plaintext,
      machineId: "machine-1",
      offeredLabels: {},
      reservedLabelKeys: [],
    },
    context,
  );
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        {
          presentedToken: plaintext,
          machineId: "machine-1",
          offeredLabels: { fleet: "a" },
          reservedLabelKeys: [],
        },
        context,
      ),
    Error,
    LABEL_CONFLICT_PHRASE,
  );
});

Deno.test("enrollmentTokenModel: redeem refuses a reserved label the token does not supply", async () => {
  const { context, store, plaintext } = await mintToken();
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        {
          presentedToken: plaintext,
          machineId: "machine-1",
          offeredLabels: { fleet: "a" },
          reservedLabelKeys: ["fleet"],
        },
        context,
      ),
    Error,
    LABEL_RESERVED_PHRASE,
  );
  assertEquals(tokenBindings(store), []);
});

Deno.test("enrollmentTokenModel: a fleet token supplies its own name for a reserved fleet label", async () => {
  const { context, store, plaintext } = await mintFleetToken("pool", 3);
  await enrollmentTokenModel.methods.redeem.execute(
    {
      presentedToken: plaintext,
      machineId: "machine-1",
      offeredLabels: { fleet: "pool" },
      reservedLabelKeys: ["fleet"],
    },
    context,
  );
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        {
          presentedToken: plaintext,
          machineId: "machine-2",
          offeredLabels: { fleet: "other" },
          reservedLabelKeys: ["fleet"],
        },
        context,
      ),
    Error,
    LABEL_RESERVED_PHRASE,
  );
  assertEquals(tokenBindings(store).length, 1);
});

Deno.test("enrollmentTokenModel: a wrong secret is refused as a mismatch before any label is judged", async () => {
  const { context } = await mintLabelledToken({ fleet: "b" }, 1, "tok");
  const error = await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        {
          presentedToken: "wrong",
          machineId: "machine-1",
          offeredLabels: { fleet: "a", region: "x" },
          reservedLabelKeys: ["region"],
        },
        context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "does not match");
  assertEquals(error.message.includes("fleet"), false);
  assertEquals(error.message.includes("region"), false);
});

Deno.test("enrollmentTokenModel: rotate, rebind and prune_bindings keep the bound labels", async () => {
  const harness = await mintLabelledToken({ fleet: "b" }, 3);
  await enrollmentTokenModel.methods.redeem.execute(
    {
      presentedToken: harness.plaintext,
      machineId: "machine-1",
      offeredLabels: {},
      reservedLabelKeys: [],
    },
    harness.context,
  );
  const { token } = await rotateToken(harness);
  assertEquals(token.labels, { fleet: "b" });
  await enrollmentTokenModel.methods.rebind.execute(
    { machineIds: ["machine-1"], mint: token.createdAt as string },
    harness.context,
  );
  assertEquals(harness.store.get("token-main")!.labels, { fleet: "b" });
  await enrollmentTokenModel.methods.prune_bindings.execute(
    { machineIds: ["machine-1"] },
    harness.context,
  );
  assertEquals(harness.store.get("token-main")!.labels, { fleet: "b" });
});

Deno.test("effectiveWorkerLabels: bound labels win, then the worker's, then the automatic fleet label", () => {
  const fleet = { name: "pool", maxEnrollments: 3 as const };
  assertEquals(
    effectiveWorkerLabels({ ...fleet, labels: {} }, { gpu: "true" }),
    { fleet: "pool", gpu: "true" },
  );
  assertEquals(
    effectiveWorkerLabels({ ...fleet, labels: {} }, { fleet: "mine" }),
    { fleet: "mine" },
  );
  assertEquals(
    effectiveWorkerLabels({ ...fleet, labels: { fleet: "b" } }, {}),
    { fleet: "b" },
  );
  assertEquals(
    effectiveWorkerLabels(
      { name: "one", maxEnrollments: 1, labels: undefined },
      { fleet: "x" },
    ),
    { fleet: "x" },
  );
});

Deno.test("workerLabelRefusal: a key named like an Object.prototype member is judged by own keys only", () => {
  const token = { name: "one", maxEnrollments: 1 as const, labels: {} };
  assertEquals(
    workerLabelRefusal(token, { constructor: "x", toString: "y" }, []),
    undefined,
  );
  assertEquals(
    workerLabelRefusal(token, { constructor: "x" }, ["constructor"]),
    { reason: "reserved", key: "constructor" },
  );
});

Deno.test("enrollmentTokenModel: a refusal keeps its phrase when a label key holds a quote", async () => {
  const { context, plaintext } = await mintLabelledToken({ "it's": "v" });
  for (
    const [offeredLabels, reservedLabelKeys, phrase] of [
      [{ "it's": "w" }, [], LABEL_CONFLICT_PHRASE],
      [{ "o'clock": "x" }, ["o'clock"], LABEL_RESERVED_PHRASE],
    ] as const
  ) {
    const error = await assertRejects(
      () =>
        enrollmentTokenModel.methods.redeem.execute(
          {
            presentedToken: plaintext,
            machineId: "machine-1",
            offeredLabels,
            reservedLabelKeys: [...reservedLabelKeys],
          },
          context,
        ),
      Error,
    );
    assertStringIncludes(withoutQuotedNames(error.message), phrase);
  }
});
