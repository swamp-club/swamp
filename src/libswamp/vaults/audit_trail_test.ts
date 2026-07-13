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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { VaultAuditEntry } from "../../domain/vaults/vault_audit_entry.ts";
import {
  vaultAuditTrail,
  type VaultAuditTrailDeps,
  type VaultAuditTrailEvent,
} from "./audit_trail.ts";

function makeDeps(
  entries: VaultAuditEntry[] = [],
): VaultAuditTrailDeps {
  return {
    findByTimeRange: () => Promise.resolve(entries),
  };
}

function makeEntry(overrides: Partial<VaultAuditEntry> = {}): VaultAuditEntry {
  return {
    timestamp: "2026-07-10T12:00:00.000Z",
    vaultName: "my-vault",
    vaultType: "local_encryption",
    secretKey: "API_KEY",
    callerContext: "cli:vault-read-secret",
    ...overrides,
  };
}

Deno.test("vaultAuditTrail: returns entries from deps", async () => {
  const deps = makeDeps([makeEntry(), makeEntry({ secretKey: "DB_PASS" })]);

  const events = await collect<VaultAuditTrailEvent>(
    vaultAuditTrail(createLibSwampContext(), deps, {}),
  );

  const completed = events.find((e) => e.kind === "completed") as Extract<
    VaultAuditTrailEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.returnedCount, 2);
  assertEquals(completed.data.truncated, false);
  assertEquals(completed.data.entries.length, 2);
});

Deno.test("vaultAuditTrail: detects truncation when results exceed limit", async () => {
  const entries = [
    makeEntry({ secretKey: "A" }),
    makeEntry({ secretKey: "B" }),
    makeEntry({ secretKey: "C" }),
  ];
  const deps: VaultAuditTrailDeps = {
    findByTimeRange: (_s, _e, opts) => {
      return Promise.resolve(entries.slice(0, opts?.limit));
    },
  };

  const events = await collect<VaultAuditTrailEvent>(
    vaultAuditTrail(createLibSwampContext(), deps, { limit: 2 }),
  );

  const completed = events.find((e) => e.kind === "completed") as Extract<
    VaultAuditTrailEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.returnedCount, 2);
  assertEquals(completed.data.truncated, true);
});

Deno.test("vaultAuditTrail: rejects inverted date range", async () => {
  const deps = makeDeps();

  const events = await collect<VaultAuditTrailEvent>(
    vaultAuditTrail(createLibSwampContext(), deps, {
      since: new Date("2026-07-10"),
      until: new Date("2026-07-01"),
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAuditTrailEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "is after");
});

Deno.test("vaultAuditTrail: rejects date range exceeding 365 days", async () => {
  const deps = makeDeps();

  const events = await collect<VaultAuditTrailEvent>(
    vaultAuditTrail(createLibSwampContext(), deps, {
      since: new Date("2024-01-01"),
      until: new Date("2026-07-10"),
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultAuditTrailEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "validation_failed");
  assertStringIncludes(last.error.message, "365 days");
});

Deno.test("vaultAuditTrail: returns empty result for no entries", async () => {
  const deps = makeDeps([]);

  const events = await collect<VaultAuditTrailEvent>(
    vaultAuditTrail(createLibSwampContext(), deps, {}),
  );

  const completed = events.find((e) => e.kind === "completed") as Extract<
    VaultAuditTrailEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.returnedCount, 0);
  assertEquals(completed.data.truncated, false);
  assertEquals(completed.data.entries.length, 0);
});
