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

import { assertEquals } from "@std/assert";
import {
  formatTtlMs,
  isVaultRefreshHookProvider,
  RefreshHook,
} from "./refresh_hook.ts";

Deno.test("RefreshHook.create: creates hook with null lastRefreshedAt", () => {
  const hook = RefreshHook.create("gcloud auth print-access-token", 3000000);
  assertEquals(hook.command, "gcloud auth print-access-token");
  assertEquals(hook.ttlMs, 3000000);
  assertEquals(hook.lastRefreshedAt, null);
});

Deno.test("RefreshHook.isStale: returns true when never refreshed", () => {
  const hook = RefreshHook.create("echo test", 60000);
  assertEquals(hook.isStale(), true);
});

Deno.test("RefreshHook.isStale: returns false when recently refreshed", () => {
  const hook = RefreshHook.create("echo test", 60000)
    .withRefreshedAt(new Date());
  assertEquals(hook.isStale(), false);
});

Deno.test("RefreshHook.isStale: returns true when TTL has elapsed", () => {
  const pastDate = new Date(Date.now() - 120000);
  const hook = RefreshHook.create("echo test", 60000)
    .withRefreshedAt(pastDate);
  assertEquals(hook.isStale(), true);
});

Deno.test("RefreshHook.toData: serializes to UTC ISO 8601 with human-readable ttl", () => {
  const timestamp = new Date("2026-06-08T18:00:00.000Z");
  const hook = RefreshHook.create("gcloud auth print-access-token", 3000000)
    .withRefreshedAt(timestamp);
  const data = hook.toData();
  assertEquals(data.command, "gcloud auth print-access-token");
  assertEquals(data.ttlMs, 3000000);
  assertEquals(data.ttl, "50m");
  assertEquals(data.lastRefreshedAt, "2026-06-08T18:00:00.000Z");
});

Deno.test("RefreshHook.toData: serializes null lastRefreshedAt", () => {
  const hook = RefreshHook.create("echo test", 60000);
  const data = hook.toData();
  assertEquals(data.lastRefreshedAt, null);
});

Deno.test("RefreshHook.fromData: round-trips through serialization", () => {
  const original = RefreshHook.create("aws sso get-role-credentials", 28800000)
    .withRefreshedAt(new Date("2026-06-08T12:00:00.000Z"));
  const data = original.toData();
  const restored = RefreshHook.fromData(data);
  assertEquals(original.equals(restored), true);
});

Deno.test("RefreshHook.fromData: handles null lastRefreshedAt", () => {
  const restored = RefreshHook.fromData({
    command: "echo test",
    ttlMs: 60000,
    ttl: "1m",
    lastRefreshedAt: null,
  });
  assertEquals(restored.lastRefreshedAt, null);
  assertEquals(restored.isStale(), true);
});

Deno.test("RefreshHook.withRefreshedAt: returns new instance", () => {
  const original = RefreshHook.create("echo test", 60000);
  const updated = original.withRefreshedAt(new Date());
  assertEquals(original.lastRefreshedAt, null);
  assertEquals(updated.lastRefreshedAt !== null, true);
});

Deno.test("RefreshHook.equals: compares all fields", () => {
  const ts = new Date("2026-06-08T18:00:00.000Z");
  const a = RefreshHook.create("echo a", 60000).withRefreshedAt(ts);
  const b = RefreshHook.create("echo a", 60000).withRefreshedAt(ts);
  const c = RefreshHook.create("echo b", 60000).withRefreshedAt(ts);
  assertEquals(a.equals(b), true);
  assertEquals(a.equals(c), false);
});

Deno.test("isVaultRefreshHookProvider: returns false for plain object", () => {
  assertEquals(isVaultRefreshHookProvider({}), false);
  assertEquals(isVaultRefreshHookProvider(null), false);
  assertEquals(isVaultRefreshHookProvider("string"), false);
});

Deno.test("isVaultRefreshHookProvider: returns true when all methods present", () => {
  const provider = {
    getRefreshHook: () => {},
    putRefreshHook: () => {},
    deleteRefreshHook: () => {},
  };
  assertEquals(isVaultRefreshHookProvider(provider), true);
});

Deno.test("formatTtlMs: formats milliseconds", () => {
  assertEquals(formatTtlMs(500), "500ms");
});

Deno.test("formatTtlMs: formats seconds", () => {
  assertEquals(formatTtlMs(2000), "2s");
  assertEquals(formatTtlMs(30000), "30s");
});

Deno.test("formatTtlMs: formats minutes", () => {
  assertEquals(formatTtlMs(60000), "1m");
  assertEquals(formatTtlMs(3000000), "50m");
});

Deno.test("formatTtlMs: formats hours", () => {
  assertEquals(formatTtlMs(3600000), "1h");
  assertEquals(formatTtlMs(28800000), "8h");
});

Deno.test("formatTtlMs: formats hours and minutes", () => {
  assertEquals(formatTtlMs(5400000), "1h30m");
});
