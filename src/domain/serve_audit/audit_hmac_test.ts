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

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  applyHmac,
  generateHmacKeyBytes,
  type HmacContext,
  hmacField,
  importHmacKey,
} from "./audit_hmac.ts";
import { createAuditEvent } from "./audit_event.ts";

async function makeContext(version = 1): Promise<HmacContext> {
  const raw = await generateHmacKeyBytes();
  const key = await importHmacKey(raw);
  return { key, keyVersion: version };
}

function makeEvent(
  overrides?: Partial<Parameters<typeof createAuditEvent>[0]>,
) {
  return createAuditEvent({
    instanceId: "test-instance",
    category: "secrets",
    stage: "response",
    outcome: "success",
    action: "vault.read-secret",
    resourceKind: "vault",
    resourceName: "api-keys",
    principalKind: "user",
    principalId: "paul",
    initiatedBy: "paul",
    sourceIp: "127.0.0.1",
    requestId: "req-1",
    ...overrides,
  });
}

Deno.test("hmacField: produces consistent hex output for same input", async () => {
  const ctx = await makeContext();
  const a = await hmacField(ctx.key, "test-value");
  const b = await hmacField(ctx.key, "test-value");
  assertEquals(a, b);
  assertEquals(a.length, 64);
});

Deno.test("hmacField: different inputs produce different hashes", async () => {
  const ctx = await makeContext();
  const a = await hmacField(ctx.key, "value-a");
  const b = await hmacField(ctx.key, "value-b");
  assertNotEquals(a, b);
});

Deno.test("hmacField: different keys produce different hashes", async () => {
  const ctx1 = await makeContext();
  const ctx2 = await makeContext();
  const a = await hmacField(ctx1.key, "same-value");
  const b = await hmacField(ctx2.key, "same-value");
  assertNotEquals(a, b);
});

Deno.test("applyHmac: hashes resourceName", async () => {
  const ctx = await makeContext();
  const event = makeEvent();
  const hashed = await applyHmac(ctx, event);
  assertNotEquals(hashed.resourceName, "api-keys");
  assertEquals(hashed.resourceName.length, 64);
});

Deno.test("applyHmac: hashes detail when present", async () => {
  const ctx = await makeContext();
  const event = makeEvent({ detail: "sensitive-detail" });
  const hashed = await applyHmac(ctx, event);
  assertNotEquals(hashed.detail, "sensitive-detail");
  assertEquals(hashed.detail!.length, 64);
});

Deno.test("applyHmac: preserves undefined detail", async () => {
  const ctx = await makeContext();
  const event = makeEvent();
  const hashed = await applyHmac(ctx, event);
  assertEquals(hashed.detail, undefined);
});

Deno.test("applyHmac: hashes methodName when present", async () => {
  const ctx = await makeContext();
  const event = makeEvent({ methodName: "readSecret" });
  const hashed = await applyHmac(ctx, event);
  assertNotEquals(hashed.methodName, "readSecret");
  assertEquals(hashed.methodName!.length, 64);
});

Deno.test("applyHmac: hashes decision.resourceName when present", async () => {
  const ctx = await makeContext();
  const event = makeEvent({
    decision: {
      action: "vault.read-secret",
      resourceKind: "vault",
      resourceName: "api-keys",
      effect: "allow",
      grantId: "g-1",
      principalGroups: [],
    },
  });
  const hashed = await applyHmac(ctx, event);
  assertNotEquals(hashed.decision!.resourceName, "api-keys");
  assertEquals(hashed.decision!.resourceName.length, 64);
  assertEquals(hashed.decision!.effect, "allow");
  assertEquals(hashed.decision!.grantId, "g-1");
});

Deno.test("applyHmac: sets hmacKeyVersion", async () => {
  const ctx = await makeContext(3);
  const event = makeEvent();
  const hashed = await applyHmac(ctx, event);
  assertEquals(hashed.hmacKeyVersion, 3);
});

Deno.test("applyHmac: preserves non-hashed fields", async () => {
  const ctx = await makeContext();
  const event = makeEvent();
  const hashed = await applyHmac(ctx, event);
  assertEquals(hashed.id, event.id);
  assertEquals(hashed.timestamp, event.timestamp);
  assertEquals(hashed.instanceId, event.instanceId);
  assertEquals(hashed.category, event.category);
  assertEquals(hashed.action, event.action);
  assertEquals(hashed.principalKind, event.principalKind);
  assertEquals(hashed.principalId, event.principalId);
  assertEquals(hashed.sourceIp, event.sourceIp);
});

Deno.test("generateHmacKeyBytes: produces key bytes", async () => {
  const raw = await generateHmacKeyBytes();
  assertEquals(raw.length, 64);
});

Deno.test("applyHmac: verification round-trip works", async () => {
  const ctx = await makeContext();
  const event = makeEvent();
  const hashed = await applyHmac(ctx, event);
  const expectedHash = await hmacField(ctx.key, "api-keys");
  assertEquals(hashed.resourceName, expectedHash);
});
