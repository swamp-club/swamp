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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  applyHmac,
  generateHmacKeyBytes,
  type HmacContext,
  hmacField,
  HmacKeyRegistry,
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

// HmacKeyRegistry tests

async function makeKeyVersion(version: number) {
  const raw = await generateHmacKeyBytes();
  const key = await importHmacKey(raw);
  return { version, key };
}

Deno.test("HmacKeyRegistry: constructor requires at least one version", () => {
  assertThrows(
    () => new HmacKeyRegistry([]),
    Error,
    "at least one key version",
  );
});

Deno.test("HmacKeyRegistry: currentContext returns highest version", async () => {
  const v1 = await makeKeyVersion(1);
  const v2 = await makeKeyVersion(2);
  const registry = new HmacKeyRegistry([v1, v2]);
  const ctx = registry.currentContext();
  assertEquals(ctx.keyVersion, 2);
});

Deno.test("HmacKeyRegistry: contextForVersion returns correct key", async () => {
  const v1 = await makeKeyVersion(1);
  const v2 = await makeKeyVersion(2);
  const registry = new HmacKeyRegistry([v1, v2]);

  const ctx1 = registry.contextForVersion(1);
  assertEquals(ctx1?.keyVersion, 1);

  const ctx2 = registry.contextForVersion(2);
  assertEquals(ctx2?.keyVersion, 2);
});

Deno.test("HmacKeyRegistry: contextForVersion returns undefined for unknown version", async () => {
  const v1 = await makeKeyVersion(1);
  const registry = new HmacKeyRegistry([v1]);
  assertEquals(registry.contextForVersion(99), undefined);
});

Deno.test("HmacKeyRegistry: addVersion increments current version", async () => {
  const v1 = await makeKeyVersion(1);
  const registry = new HmacKeyRegistry([v1]);
  assertEquals(registry.currentVersion, 1);

  const v2 = await makeKeyVersion(2);
  registry.addVersion(2, v2.key);
  assertEquals(registry.currentVersion, 2);
  assertEquals(registry.versionCount, 2);
});

Deno.test("HmacKeyRegistry: addVersion rejects non-increasing version", async () => {
  const v1 = await makeKeyVersion(1);
  const v2 = await makeKeyVersion(2);
  const registry = new HmacKeyRegistry([v1, v2]);

  const v1b = await makeKeyVersion(1);
  assertThrows(
    () => registry.addVersion(1, v1b.key),
    Error,
    "must be greater than current version",
  );
});

Deno.test("HmacKeyRegistry: versions returns sorted list", async () => {
  const v3 = await makeKeyVersion(3);
  const v1 = await makeKeyVersion(1);
  const v2 = await makeKeyVersion(2);
  const registry = new HmacKeyRegistry([v3, v1, v2]);
  assertEquals(registry.versions(), [1, 2, 3]);
});

Deno.test("HmacKeyRegistry: single version bootstrap works", async () => {
  const v1 = await makeKeyVersion(1);
  const registry = new HmacKeyRegistry([v1]);
  assertEquals(registry.currentVersion, 1);
  assertEquals(registry.versionCount, 1);
  const ctx = registry.currentContext();
  assertEquals(ctx.keyVersion, 1);
});

Deno.test("HmacKeyRegistry: different versions produce different hashes", async () => {
  const v1 = await makeKeyVersion(1);
  const v2 = await makeKeyVersion(2);
  const registry = new HmacKeyRegistry([v1, v2]);

  const ctx1 = registry.contextForVersion(1)!;
  const ctx2 = registry.contextForVersion(2)!;

  const hash1 = await hmacField(ctx1.key, "test-value");
  const hash2 = await hmacField(ctx2.key, "test-value");
  assertNotEquals(hash1, hash2);
});
