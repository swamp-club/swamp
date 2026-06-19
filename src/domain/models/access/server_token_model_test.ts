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
  SERVER_TOKEN_MODEL_TYPE,
  serverTokenModel,
  serverTokenSecretKey,
} from "./server_token_model.ts";
import { createInMemoryWorkerContext } from "../worker/worker_test_helpers.ts";

const mintArgs = {
  principalId: "oauth|user-123",
  principalEmail: "user@example.com",
  vaultName: "local",
};

async function mintToken(name = "user-token-1") {
  const harness = createInMemoryWorkerContext(
    SERVER_TOKEN_MODEL_TYPE,
    name,
  );
  await serverTokenModel.methods.mint.execute(mintArgs, harness.context);
  const plaintext = harness.vault.get(
    `local/${serverTokenSecretKey(name)}`,
  )!;
  return {
    ...harness,
    plaintext,
    fullToken: `${name}.${plaintext}`,
  };
}

Deno.test("serverTokenModel: mint writes the secret to the vault, never to data", async () => {
  const { store, plaintext } = await mintToken();
  const token = store.get("token-main")!;
  assertEquals(token.state, "active");
  assertEquals(token.vaultName, "local");
  assertEquals(token.secretKey, serverTokenSecretKey("user-token-1"));
  assertEquals(token.principalId, "oauth|user-123");
  assertEquals(token.principalEmail, "user@example.com");
  assertEquals(typeof plaintext, "string");
  assertEquals(plaintext.length, 64);
  assertEquals(JSON.stringify(token).includes(plaintext), false);
});

Deno.test("serverTokenModel: caller reads plaintext from vault after mint", async () => {
  const { plaintext } = await mintToken();
  assertEquals(typeof plaintext, "string");
  assertEquals(plaintext.length, 64);
});

Deno.test("serverTokenModel: mint twice with the same name fails", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () => serverTokenModel.methods.mint.execute(mintArgs, context),
    Error,
    "already exists",
  );
});

Deno.test("serverTokenModel: mint uses default 30-day expiry when durationMs not provided", async () => {
  const { store } = await mintToken();
  const token = store.get("token-main")!;
  const createdAt = Date.parse(token.createdAt as string);
  const expiresAt = Date.parse(token.expiresAt as string);
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  assertEquals(expiresAt - createdAt, thirtyDaysMs);
});

Deno.test("serverTokenModel: mint respects custom durationMs", async () => {
  const harness = createInMemoryWorkerContext(
    SERVER_TOKEN_MODEL_TYPE,
    "custom-duration",
  );
  await serverTokenModel.methods.mint.execute(
    { ...mintArgs, durationMs: 60_000 },
    harness.context,
  );
  const token = harness.store.get("token-main")!;
  const createdAt = Date.parse(token.createdAt as string);
  const expiresAt = Date.parse(token.expiresAt as string);
  assertEquals(expiresAt - createdAt, 60_000);
});

Deno.test("serverTokenModel: redeem succeeds with valid token and updates lastUsedAt", async () => {
  const { context, store, fullToken } = await mintToken();
  await serverTokenModel.methods.redeem.execute(
    { presentedToken: fullToken },
    context,
  );
  const token = store.get("token-main")!;
  assertEquals(typeof token.lastUsedAt, "string");
});

Deno.test("serverTokenModel: redeem with wrong secret fails", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: "user-token-1.wrongsecret" },
        context,
      ),
    Error,
    "does not match",
  );
});

Deno.test("serverTokenModel: redeem rejects token with wrong name prefix", async () => {
  const { context, plaintext } = await mintToken();
  await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: `wrong-name.${plaintext}` },
        context,
      ),
    Error,
    "name mismatch",
  );
});

Deno.test("serverTokenModel: redeem with malformed token (no dot) fails", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: "nodottoken" },
        context,
      ),
    Error,
    "Invalid token format",
  );
});

Deno.test("serverTokenModel: redeem of expired token fails", async () => {
  const { context, store, fullToken } = await mintToken();
  store.get("token-main")!.expiresAt = new Date(Date.now() - 1_000)
    .toISOString();
  await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: fullToken },
        context,
      ),
    Error,
    "expired",
  );
});

Deno.test("serverTokenModel: redeem of revoked token fails", async () => {
  const { context, fullToken } = await mintToken();
  await serverTokenModel.methods.revoke.execute({}, context);
  await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: fullToken },
        context,
      ),
    Error,
    "revoked",
  );
});

Deno.test("serverTokenModel: revoke transitions active to revoked", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.revoke.execute({}, context);
  const token = store.get("token-main")!;
  assertEquals(token.state, "revoked");
  assertEquals(typeof token.revokedAt, "string");
});

Deno.test("serverTokenModel: revoke is idempotent", async () => {
  const { context, versions } = await mintToken();
  await serverTokenModel.methods.revoke.execute({}, context);
  const after = versions.get("token-main");
  await serverTokenModel.methods.revoke.execute({}, context);
  assertEquals(versions.get("token-main"), after);
});

Deno.test("serverTokenModel: expire transitions active to expired", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.expire.execute({}, context);
  assertEquals(store.get("token-main")!.state, "expired");
});

Deno.test("serverTokenModel: expire is idempotent on expired", async () => {
  const { context, versions } = await mintToken();
  await serverTokenModel.methods.expire.execute({}, context);
  const after = versions.get("token-main");
  await serverTokenModel.methods.expire.execute({}, context);
  assertEquals(versions.get("token-main"), after);
});

Deno.test("serverTokenModel: expire is idempotent on revoked", async () => {
  const { context, versions } = await mintToken();
  await serverTokenModel.methods.revoke.execute({}, context);
  const after = versions.get("token-main");
  await serverTokenModel.methods.expire.execute({}, context);
  assertEquals(versions.get("token-main"), after);
});

Deno.test("serverTokenModel: lastUsedAt updates on each successful redeem", async () => {
  const { context, store, fullToken } = await mintToken();
  await serverTokenModel.methods.redeem.execute(
    { presentedToken: fullToken },
    context,
  );
  const firstUsedAt = store.get("token-main")!.lastUsedAt as string;

  await new Promise((r) => setTimeout(r, 5));
  await serverTokenModel.methods.redeem.execute(
    { presentedToken: fullToken },
    context,
  );
  const secondUsedAt = store.get("token-main")!.lastUsedAt as string;
  assertNotEquals(firstUsedAt, secondUsedAt);
});

Deno.test("serverTokenModel: minted tokens are unique across instances", async () => {
  const a = await mintToken("token-a");
  const b = await mintToken("token-b");
  assertNotEquals(a.plaintext, b.plaintext);
});

Deno.test("serverTokenModel: redeem does not bind to a machine (works from any caller)", async () => {
  const { context, store, fullToken } = await mintToken();
  await serverTokenModel.methods.redeem.execute(
    { presentedToken: fullToken },
    context,
  );
  const token = store.get("token-main")!;
  assertEquals(token.state, "active");
  assertEquals("boundMachineId" in token, false);
});

Deno.test("serverTokenModel: mint without vault service throws", async () => {
  const harness = createInMemoryWorkerContext(
    SERVER_TOKEN_MODEL_TYPE,
    "no-vault",
  );
  const ctx = { ...harness.context, vaultService: undefined };
  await assertRejects(
    () =>
      serverTokenModel.methods.mint.execute(
        mintArgs,
        ctx as typeof harness.context,
      ),
    Error,
    "requires a vault service",
  );
});

Deno.test("serverTokenModel: redeem without vault service throws", async () => {
  const { context, fullToken } = await mintToken();
  const ctx = { ...context, vaultService: undefined };
  const error = await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: fullToken },
        ctx as typeof context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "requires a vault service");
});

Deno.test("serverTokenModel: rotate active token produces new credentials", async () => {
  const { context, store, vault, plaintext } = await mintToken();
  const oldSecretKey = store.get("token-main")!.secretKey as string;
  await serverTokenModel.methods.rotate.execute({}, context);
  const token = store.get("token-main")!;
  assertEquals(token.state, "active");
  assertEquals(token.principalId, "oauth|user-123");
  assertEquals(token.principalEmail, "user@example.com");
  const newPlaintext = vault.get(`local/${oldSecretKey}`)!;
  assertNotEquals(newPlaintext, plaintext);
});

Deno.test("serverTokenModel: rotate preserves principal from original token", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.rotate.execute({}, context);
  const token = store.get("token-main")!;
  assertEquals(token.principalId, "oauth|user-123");
  assertEquals(token.principalEmail, "user@example.com");
});

Deno.test("serverTokenModel: rotate respects custom durationMs", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.rotate.execute(
    { durationMs: 120_000 },
    context,
  );
  const token = store.get("token-main")!;
  const createdAt = Date.parse(token.createdAt as string);
  const expiresAt = Date.parse(token.expiresAt as string);
  assertEquals(expiresAt - createdAt, 120_000);
});

Deno.test("serverTokenModel: rotate expired token succeeds", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.expire.execute({}, context);
  assertEquals(store.get("token-main")!.state, "expired");
  await serverTokenModel.methods.rotate.execute({}, context);
  assertEquals(store.get("token-main")!.state, "active");
});

Deno.test("serverTokenModel: rotate revoked token succeeds", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.revoke.execute({}, context);
  assertEquals(store.get("token-main")!.state, "revoked");
  await serverTokenModel.methods.rotate.execute({}, context);
  assertEquals(store.get("token-main")!.state, "active");
});

Deno.test("serverTokenModel: rotate nonexistent token throws", async () => {
  const harness = createInMemoryWorkerContext(
    SERVER_TOKEN_MODEL_TYPE,
    "missing-token",
  );
  await assertRejects(
    () => serverTokenModel.methods.rotate.execute({}, harness.context),
    Error,
    "does not exist",
  );
});

Deno.test("serverTokenModel: rotate without vault service throws", async () => {
  const { context } = await mintToken();
  const ctx = { ...context, vaultService: undefined };
  await assertRejects(
    () =>
      serverTokenModel.methods.rotate.execute(
        {},
        ctx as typeof context,
      ),
    Error,
    "requires a vault service",
  );
});

Deno.test("serverTokenModel: rotated token is redeemable with new credentials", async () => {
  const { context, store } = await mintToken();
  await serverTokenModel.methods.rotate.execute({}, context);
  const token = store.get("token-main")!;
  const newPlaintext = (context as unknown as {
    vaultService: { get: (v: string, k: string) => Promise<string> };
  })
    .vaultService.get(token.vaultName as string, token.secretKey as string);
  const plaintext = await newPlaintext;
  await serverTokenModel.methods.redeem.execute(
    { presentedToken: `user-token-1.${plaintext}` },
    context,
  );
  assertEquals(store.get("token-main")!.lastUsedAt !== undefined, true);
});

Deno.test("serverTokenModel: old credentials fail after rotate", async () => {
  const { context, fullToken } = await mintToken();
  await serverTokenModel.methods.rotate.execute({}, context);
  await assertRejects(
    () =>
      serverTokenModel.methods.redeem.execute(
        { presentedToken: fullToken },
        context,
      ),
    Error,
    "does not match",
  );
});
