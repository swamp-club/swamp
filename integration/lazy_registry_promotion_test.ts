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
 * get() returns undefined for lazy entries; ensureTypeLoaded must run first, so
 * resolveVaultType and resolveDatastoreType must promote lazy entries before
 * returning
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
  type LazyReportEntry,
  ReportRegistry,
} from "../src/domain/reports/report_registry.ts";
import type { ReportDefinition } from "../src/domain/reports/report.ts";
import {
  resolveDatastoreType,
  resolveVaultType,
} from "../src/domain/extensions/extension_auto_resolver.ts";

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

Deno.test("resolveVaultType: promotes lazy type so get() works after resolution", async () => {
  const typeName = "@test/resolve-vault-" + crypto.randomUUID().slice(0, 8);

  vaultTypeRegistry.registerLazy(lazyVault(typeName));
  vaultTypeRegistry.setTypeLoader((type) => {
    vaultTypeRegistry.promoteFromLazy(vaultInfo(type));
    return Promise.resolve();
  });

  const resolved = await resolveVaultType(typeName, null);
  assertEquals(resolved, true, "should resolve successfully");

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

  const resolved = await resolveDatastoreType(typeName, null);
  assertEquals(resolved, true, "should resolve successfully");

  const result = datastoreTypeRegistry.get(typeName);
  assertNotEquals(
    result,
    undefined,
    "get() must return the type after resolveDatastoreType() — " +
      "if this fails, resolveDatastoreType() is not calling ensureTypeLoaded()",
  );
  assertEquals(result!.type, typeName);
});
