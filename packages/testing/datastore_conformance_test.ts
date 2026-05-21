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

import { assertThrows } from "@std/assert";
import {
  assertDatastoreExportConformance,
  assertLockConformance,
  assertSyncServiceConformance,
  assertVerifierConformance,
} from "./datastore_conformance.ts";
import { createDatastoreTestContext } from "./datastore_test_context.ts";

// --- assertDatastoreExportConformance ---

Deno.test("assertDatastoreExportConformance: passes for valid export", () => {
  const { provider } = createDatastoreTestContext();
  const validExport = {
    type: "@test/my-datastore",
    name: "Test Datastore",
    description: "A test datastore provider",
    configSchema: {
      safeParse: (v: unknown) => {
        const obj = v as Record<string, unknown>;
        return { success: typeof obj?.bucket === "string" };
      },
    },
    createProvider: (_config: Record<string, unknown>) => provider,
  };

  assertDatastoreExportConformance(validExport, {
    validConfigs: [{ bucket: "my-bucket" }],
    invalidConfigs: [{}],
  });
});

Deno.test("assertDatastoreExportConformance: fails for bad type pattern", () => {
  const { provider } = createDatastoreTestContext();
  const badExport = {
    type: "INVALID",
    name: "Test",
    description: "Test",
    configSchema: { safeParse: () => ({ success: true }) },
    createProvider: () => provider,
  };

  assertThrows(
    () =>
      assertDatastoreExportConformance(
        badExport as Parameters<typeof assertDatastoreExportConformance>[0],
        { validConfigs: [{}] },
      ),
    Error,
    "must match pattern",
  );
});

// --- assertLockConformance ---

Deno.test("assertLockConformance: passes for conforming in-memory lock", async () => {
  const { provider } = createDatastoreTestContext();
  const lock = provider.createLock("/test/path");
  await assertLockConformance(lock);
});

// --- assertVerifierConformance ---

Deno.test("assertVerifierConformance: passes for conforming verifier", async () => {
  const { provider } = createDatastoreTestContext();
  const verifier = provider.createVerifier();
  await assertVerifierConformance(verifier);
});

Deno.test("assertVerifierConformance: passes for unhealthy verifier", async () => {
  const { provider } = createDatastoreTestContext({
    healthResult: { healthy: false, message: "Unreachable" },
  });
  const verifier = provider.createVerifier();
  await assertVerifierConformance(verifier);
});

// --- assertSyncServiceConformance ---

Deno.test("assertSyncServiceConformance: passes for basic sync service", async () => {
  const { provider } = createDatastoreTestContext({ withSyncService: true });
  const syncService = provider.createSyncService!("/repo", "/cache");
  await assertSyncServiceConformance(syncService);
});

Deno.test("assertSyncServiceConformance: passes for sync service with capabilities", async () => {
  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
    capabilities: () => ({ scopedSync: true }),
  };
  await assertSyncServiceConformance(syncService, { expectScopedSync: true });
});

Deno.test("assertSyncServiceConformance: passes without capabilities method", async () => {
  const syncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  await assertSyncServiceConformance(syncService);
});
