// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ApiKeyData } from "../../domain/auth/api_key.ts";
import {
  renderApiKeyCreate,
  renderApiKeyDelete,
  renderApiKeyList,
  renderApiKeyRevoke,
} from "./auth_apikey_output.ts";

await initializeLogging({});

const testKey: ApiKeyData = {
  id: "key-abc123",
  name: "my-test-key",
  start: "swamp_abc",
  prefix: "swamp",
  enabled: true,
  createdAt: "2026-01-15T10:30:00Z",
  updatedAt: "2026-01-15T10:30:00Z",
  lastUsedAt: null,
  lastRefillAt: null,
  rateLimitEnabled: false,
  rateLimitTimeWindow: 0,
  rateLimitMax: 0,
  requestCount: 0,
  remaining: null,
  refillAmount: null,
  refillInterval: null,
  metadata: null,
  expiresAt: null,
  permissions: null,
  userId: "u1",
};

function captureOutput(fn: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
    return stripAnsiCode(logs.join("\n"));
  } finally {
    console.log = originalLog;
  }
}

// --- renderApiKeyList ---

Deno.test("renderApiKeyList json mode outputs valid JSON array", () => {
  const output = captureOutput(() => renderApiKeyList([testKey], "json"));
  const parsed = JSON.parse(output);
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].id, "key-abc123");
  assertEquals(parsed[0].name, "my-test-key");
});

Deno.test("renderApiKeyList log mode shows key details in table", () => {
  const output = captureOutput(() => renderApiKeyList([testKey], "log"));
  assertStringIncludes(output, "key-abc123");
  assertStringIncludes(output, "my-test-key");
  assertStringIncludes(output, "active");
  assertStringIncludes(output, "2026-01-15");
});

Deno.test("renderApiKeyList log mode shows revoked status", () => {
  const revokedKey = { ...testKey, enabled: false };
  const output = captureOutput(() => renderApiKeyList([revokedKey], "log"));
  assertStringIncludes(output, "revoked");
});

Deno.test("renderApiKeyList log mode shows message for empty list", () => {
  const output = captureOutput(() => renderApiKeyList([], "log"));
  assertStringIncludes(output, "No API keys found");
});

// --- renderApiKeyCreate ---

Deno.test("renderApiKeyCreate json mode outputs valid JSON", () => {
  const data = { id: "key-1", key: "swamp_full_key_value", name: "test" };
  const output = captureOutput(() => renderApiKeyCreate(data, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.id, "key-1");
  assertEquals(parsed.key, "swamp_full_key_value");
  assertEquals(parsed.name, "test");
});

Deno.test("renderApiKeyCreate log mode shows key and warning", () => {
  const data = { id: "key-1", key: "swamp_full_key_value", name: "test" };
  const output = captureOutput(() => renderApiKeyCreate(data, "log"));
  assertStringIncludes(output, "API key created");
  assertStringIncludes(output, "swamp_full_key_value");
  assertStringIncludes(output, "Store this key securely");
  assertStringIncludes(output, "test");
});

// --- renderApiKeyRevoke ---

Deno.test("renderApiKeyRevoke json mode outputs valid JSON", () => {
  const output = captureOutput(() => renderApiKeyRevoke("key-1", "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.revoked, true);
  assertEquals(parsed.keyId, "key-1");
});

Deno.test("renderApiKeyRevoke log mode shows confirmation", () => {
  const output = captureOutput(() => renderApiKeyRevoke("key-1", "log"));
  assertStringIncludes(output, "key-1");
  assertStringIncludes(output, "revoked");
});

// --- renderApiKeyDelete ---

Deno.test("renderApiKeyDelete json mode outputs valid JSON", () => {
  const output = captureOutput(() => renderApiKeyDelete("key-1", "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.deleted, true);
  assertEquals(parsed.keyId, "key-1");
});

Deno.test("renderApiKeyDelete log mode shows confirmation", () => {
  const output = captureOutput(() => renderApiKeyDelete("key-1", "log"));
  assertStringIncludes(output, "key-1");
  assertStringIncludes(output, "deleted");
});
