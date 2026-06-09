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
  ENROLLMENT_TOKEN_MODEL_TYPE,
  enrollmentTokenModel,
  timingSafeEqual,
  tokenSecretKey,
} from "./enrollment_token_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const mintArgs = { durationMs: 60_000, vaultName: "local" };

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
  assertEquals(typeof plaintext, "string");
  assertEquals(plaintext.length, 64);
  // The plaintext must not appear anywhere in the persisted record.
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

Deno.test("enrollmentTokenModel: redeem transitions unused → enrolled and binds the instance", async () => {
  const { context, store, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, instanceUuid: "uuid-1" },
    context,
  );
  const token = store.get("token-main")!;
  assertEquals(token.state, "enrolled");
  assertEquals(token.boundInstanceUuid, "uuid-1");
  assertEquals(typeof token.enrolledAt, "string");
});

Deno.test("enrollmentTokenModel: redeem with a wrong token fails", async () => {
  const { context } = await mintToken();
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: "wrong", instanceUuid: "uuid-1" },
        context,
      ),
    Error,
    "does not match",
  );
});

Deno.test("enrollmentTokenModel: re-auth of the bound instance succeeds without a new version", async () => {
  const { context, versions, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, instanceUuid: "uuid-1" },
    context,
  );
  const versionsAfterEnroll = versions.get("token-main");
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, instanceUuid: "uuid-1" },
    context,
  );
  assertEquals(versions.get("token-main"), versionsAfterEnroll);
});

Deno.test("enrollmentTokenModel: a second instance cannot claim an enrolled token", async () => {
  const { context, plaintext } = await mintToken();
  await enrollmentTokenModel.methods.redeem.execute(
    { presentedToken: plaintext, instanceUuid: "uuid-1" },
    context,
  );
  const error = await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, instanceUuid: "uuid-2" },
        context,
      ),
    Error,
  );
  assertStringIncludes(error.message, "already bound");
});

Deno.test("enrollmentTokenModel: redeem of an expired token fails", async () => {
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
        { presentedToken: plaintext, instanceUuid: "uuid-1" },
        harness.context,
      ),
    Error,
    "expired",
  );
});

Deno.test("enrollmentTokenModel: revoke blocks subsequent redemption", async () => {
  const { context, plaintext, store } = await mintToken();
  await enrollmentTokenModel.methods.revoke.execute({}, context);
  assertEquals(store.get("token-main")!.state, "revoked");
  await assertRejects(
    () =>
      enrollmentTokenModel.methods.redeem.execute(
        { presentedToken: plaintext, instanceUuid: "uuid-1" },
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

Deno.test("timingSafeEqual: equal and unequal strings", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
  assertEquals(timingSafeEqual("", ""), true);
  assertEquals(timingSafeEqual("", "x"), false);
});
