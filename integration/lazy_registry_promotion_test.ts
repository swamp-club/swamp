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

/**
 * Integration tests for the lazy registry promotion pattern.
 *
 * PR #1089 introduced lazy per-bundle loading where registries track "lazy
 * entries" — types known to exist but whose bundles haven't been imported.
 * The critical invariant is:
 *
 *   get() returns undefined for lazy entries.
 *   ensureTypeLoaded(type) must be called before get() to promote them.
 *
 * Category 1 tests (fresh instances) document this invariant.
 * Category 2 tests verify that consumer functions (resolveVaultType,
 * resolveDatastoreType) promote lazy entries before returning, so that
 * callers can safely use get() afterwards. These tests FAIL on the
 * unfixed code (PR #1089) and PASS with the fix (PR #1116).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  type LazyVaultEntry,
  type VaultTypeInfo,
  VaultTypeRegistry,
  vaultTypeRegistry,
} from "../src/domain/vaults/vault_type_registry.ts";
import {
  type DatastoreTypeInfo,
  DatastoreTypeRegistry,
  datastoreTypeRegistry,
  type LazyDatastoreEntry,
} from "../src/domain/datastore/datastore_type_registry.ts";
import {
  type DriverTypeInfo,
  DriverTypeRegistry,
  type LazyDriverEntry,
} from "../src/domain/drivers/driver_type_registry.ts";
import {
  type LazyReportEntry,
  ReportRegistry,
} from "../src/domain/reports/report_registry.ts";
import type { ReportDefinition } from "../src/domain/reports/report.ts";
import {
  resolveDatastoreType,
  resolveVaultType,
} from "../src/domain/extensions/extension_auto_resolver.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lazyVault(type: string): LazyVaultEntry {
  return {
    type,
    bundlePath: `/fake/vault-bundles/${type}.js`,
    sourcePath: `/fake/vaults/${type}.ts`,
    version: "1.0.0",
  };
}

function vaultInfo(type: string): VaultTypeInfo {
  return {
    type,
    name: `Test Vault ${type}`,
    description: "test vault type",
    isBuiltIn: false,
  };
}

function lazyDatastore(type: string): LazyDatastoreEntry {
  return {
    type,
    bundlePath: `/fake/datastore-bundles/${type}.js`,
    sourcePath: `/fake/datastores/${type}.ts`,
    version: "1.0.0",
  };
}

function datastoreInfo(type: string): DatastoreTypeInfo {
  return {
    type,
    name: `Test Datastore ${type}`,
    description: "test datastore type",
    isBuiltIn: false,
  };
}

function lazyDriver(type: string): LazyDriverEntry {
  return {
    type,
    bundlePath: `/fake/driver-bundles/${type}.js`,
    sourcePath: `/fake/drivers/${type}.ts`,
    version: "1.0.0",
  };
}

function driverInfo(type: string): DriverTypeInfo {
  return {
    type,
    name: `Test Driver ${type}`,
    description: "test driver type",
    isBuiltIn: false,
  };
}

function lazyReport(type: string): LazyReportEntry {
  return {
    type,
    bundlePath: `/fake/report-bundles/${type}.js`,
    sourcePath: `/fake/reports/${type}.ts`,
    version: "1.0.0",
  };
}

function reportDef(): ReportDefinition {
  return {
    description: "test report",
    scope: "model",
    execute: () => Promise.resolve({ markdown: "", json: {} }),
  };
}

// ---------------------------------------------------------------------------
// 1. Registry-level invariant tests (fresh instances)
//
// These document the contract introduced by PR #1089:
//   - get() returns undefined for lazy entries
//   - ensureTypeLoaded() promotes lazy entries so get() works
//
// These pass on both main and the fix — they test the registry itself.
// ---------------------------------------------------------------------------

Deno.test("VaultTypeRegistry: get() returns undefined for lazy entries", () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(lazyVault("@test/vault-lazy"));

  assertEquals(registry.has("@test/vault-lazy"), true);
  assertEquals(registry.get("@test/vault-lazy"), undefined);
});

Deno.test("VaultTypeRegistry: ensureTypeLoaded() promotes lazy entry for get()", async () => {
  const registry = new VaultTypeRegistry();
  registry.registerLazy(lazyVault("@test/vault-promote"));
  registry.setTypeLoader((type) => {
    registry.promoteFromLazy(vaultInfo(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@test/vault-promote");

  const result = registry.get("@test/vault-promote");
  assertNotEquals(result, undefined);
  assertEquals(result!.type, "@test/vault-promote");
});

Deno.test("DatastoreTypeRegistry: get() returns undefined for lazy entries", () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(lazyDatastore("@test/ds-lazy"));

  assertEquals(registry.has("@test/ds-lazy"), true);
  assertEquals(registry.get("@test/ds-lazy"), undefined);
});

Deno.test("DatastoreTypeRegistry: ensureTypeLoaded() promotes lazy entry for get()", async () => {
  const registry = new DatastoreTypeRegistry();
  registry.registerLazy(lazyDatastore("@test/ds-promote"));
  registry.setTypeLoader((type) => {
    registry.promoteFromLazy(datastoreInfo(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@test/ds-promote");

  const result = registry.get("@test/ds-promote");
  assertNotEquals(result, undefined);
  assertEquals(result!.type, "@test/ds-promote");
});

Deno.test("DriverTypeRegistry: get() returns undefined for lazy entries", () => {
  const registry = new DriverTypeRegistry();
  registry.registerLazy(lazyDriver("@test/driver-lazy"));

  assertEquals(registry.has("@test/driver-lazy"), true);
  assertEquals(registry.get("@test/driver-lazy"), undefined);
});

Deno.test("DriverTypeRegistry: ensureTypeLoaded() promotes lazy entry for get()", async () => {
  const registry = new DriverTypeRegistry();
  registry.registerLazy(lazyDriver("@test/driver-promote"));
  registry.setTypeLoader((type) => {
    registry.promoteFromLazy(driverInfo(type));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@test/driver-promote");

  const result = registry.get("@test/driver-promote");
  assertNotEquals(result, undefined);
  assertEquals(result!.type, "@test/driver-promote");
});

Deno.test("ReportRegistry: get() returns undefined for lazy entries", () => {
  const registry = new ReportRegistry();
  registry.registerLazy(lazyReport("@test/report-lazy"));

  assertEquals(registry.has("@test/report-lazy"), true);
  assertEquals(registry.get("@test/report-lazy"), undefined);
});

Deno.test("ReportRegistry: ensureTypeLoaded() promotes lazy entry for get()", async () => {
  const registry = new ReportRegistry();
  const name = "@test/report-promote";
  registry.registerLazy(lazyReport(name));
  registry.setTypeLoader((type) => {
    registry.promoteFromLazy(type, reportDef());
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded(name);

  const result = registry.get(name);
  assertNotEquals(result, undefined);
  assertEquals(result!.description, "test report");
});

// ---------------------------------------------------------------------------
// 2. Consumer function regression tests (global singletons)
//
// These verify that resolveVaultType() and resolveDatastoreType() promote
// lazy entries so that callers can safely use get() after resolution.
//
// On the unfixed code (PR #1089): the resolve functions don't call
// ensureTypeLoaded(), so get() returns undefined after resolution → FAIL.
//
// With the fix (PR #1116): ensureTypeLoaded() is called before has(),
// promoting the lazy entry → get() works → PASS.
// ---------------------------------------------------------------------------

Deno.test("resolveVaultType: promotes lazy type so get() works after resolution", async () => {
  const typeName = "@test/resolve-vault-" + crypto.randomUUID().slice(0, 8);

  vaultTypeRegistry.registerLazy(lazyVault(typeName));
  vaultTypeRegistry.setTypeLoader((type) => {
    vaultTypeRegistry.promoteFromLazy(vaultInfo(type));
    return Promise.resolve();
  });

  // resolveVaultType should ensure the type is promoted before returning.
  // On unfixed code, has() returns true but ensureTypeLoaded() is never
  // called, leaving the type lazy.
  const resolved = await resolveVaultType(typeName, null);
  assertEquals(resolved, true, "should resolve successfully");

  // The critical assertion: get() must return the type, not undefined.
  const result = vaultTypeRegistry.get(typeName);
  assertNotEquals(
    result,
    undefined,
    "get() must return the type after resolveVaultType() — " +
      "if this fails, resolveVaultType() is not calling ensureTypeLoaded()",
  );
  assertEquals(result!.type, typeName);
});

Deno.test("resolveDatastoreType: promotes lazy type so get() works after resolution", async () => {
  const typeName = "@test/resolve-ds-" + crypto.randomUUID().slice(0, 8);

  datastoreTypeRegistry.registerLazy(lazyDatastore(typeName));
  datastoreTypeRegistry.setTypeLoader((type) => {
    datastoreTypeRegistry.promoteFromLazy(datastoreInfo(type));
    return Promise.resolve();
  });

  // resolveDatastoreType should ensure the type is promoted before returning.
  const resolved = await resolveDatastoreType(typeName, null);
  assertEquals(resolved, true, "should resolve successfully");

  // The critical assertion: get() must return the type, not undefined.
  const result = datastoreTypeRegistry.get(typeName);
  assertNotEquals(
    result,
    undefined,
    "get() must return the type after resolveDatastoreType() — " +
      "if this fails, resolveDatastoreType() is not calling ensureTypeLoaded()",
  );
  assertEquals(result!.type, typeName);
});
