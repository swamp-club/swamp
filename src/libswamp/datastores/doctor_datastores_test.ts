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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  doctorDatastores,
  type DoctorDatastoresDeps,
  type DoctorDatastoresEvent,
} from "./doctor_datastores.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";

function makeDeps(
  config: DatastoreConfig,
  healthResult: { healthy: boolean; message: string; latencyMs: number },
  vaults: Array<{ name: string; type: string }>,
): DoctorDatastoresDeps {
  return {
    getDatastoreConfig: () => Promise.resolve(config),
    checkHealth: () => Promise.resolve(healthResult),
    getVaultConfigs: () => Promise.resolve(vaults),
  };
}

const filesystemConfig: DatastoreConfig = {
  type: "filesystem",
  path: "/tmp/test-repo/.swamp",
};

const customConfig: DatastoreConfig = {
  type: "@swamp/s3-datastore",
  config: { bucket: "test-bucket" },
  datastorePath: "/tmp/cache",
};

Deno.test("doctorDatastores: filesystem datastore, healthy", async () => {
  const deps = makeDeps(
    filesystemConfig,
    { healthy: true, message: "Datastore is accessible", latencyMs: 1 },
    [],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.datastoreType, "filesystem");
    assertEquals(completed.data.isCustom, false);
    assertEquals(completed.data.healthFindings.length, 1);
    assertEquals(completed.data.healthFindings[0].passed, true);
    assertEquals(completed.data.vaultMismatchFindings.length, 0);
  }
});

Deno.test("doctorDatastores: custom datastore, healthy, no local_encryption vaults", async () => {
  const deps = makeDeps(
    customConfig,
    { healthy: true, message: "S3 bucket accessible", latencyMs: 42 },
    [{ name: "prod-vault", type: "aws_secretsmanager" }],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.datastoreType, "@swamp/s3-datastore");
    assertEquals(completed.data.isCustom, true);
    assertEquals(completed.data.healthFindings.length, 1);
    assertEquals(completed.data.healthFindings[0].passed, true);
    assertEquals(completed.data.vaultMismatchFindings.length, 0);
  }
});

Deno.test("doctorDatastores: custom datastore, unhealthy", async () => {
  const deps = makeDeps(
    customConfig,
    { healthy: false, message: "S3 bucket not found", latencyMs: 100 },
    [],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.healthFindings.length, 1);
    assertEquals(completed.data.healthFindings[0].passed, false);
    assertEquals(
      completed.data.healthFindings[0].message,
      "S3 bucket not found",
    );
  }
});

Deno.test("doctorDatastores: custom datastore, healthy, local_encryption vaults flagged", async () => {
  const deps = makeDeps(
    customConfig,
    { healthy: true, message: "S3 bucket accessible", latencyMs: 30 },
    [
      { name: "local-vault", type: "local_encryption" },
      { name: "remote-vault", type: "aws_secretsmanager" },
    ],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.healthFindings[0].passed, true);
    assertEquals(completed.data.vaultMismatchFindings.length, 1);
    assertEquals(
      completed.data.vaultMismatchFindings[0].vaultName,
      "local-vault",
    );
    assertEquals(
      completed.data.vaultMismatchFindings[0].vaultType,
      "local_encryption",
    );
  }
});

Deno.test("doctorDatastores: filesystem datastore skips vault mismatch check", async () => {
  const deps = makeDeps(
    filesystemConfig,
    { healthy: true, message: "Datastore is accessible", latencyMs: 1 },
    [{ name: "local-vault", type: "local_encryption" }],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    // Vault mismatch is not checked for filesystem datastores
    assertEquals(completed.data.vaultMismatchFindings.length, 0);
  }
});

Deno.test("doctorDatastores: emits scanning event first", async () => {
  const deps = makeDeps(
    filesystemConfig,
    { healthy: true, message: "OK", latencyMs: 1 },
    [],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  assertEquals(events[0].kind, "scanning");
  assertEquals(events[1].kind, "completed");
});

// ============================================================================
// Un-migrated namespace data detection
// ============================================================================

Deno.test("doctorDatastores: flags un-migrated data when namespace is set", async () => {
  const configWithNs: DatastoreConfig = {
    type: "@swamp/s3-datastore",
    config: { bucket: "test" },
    datastorePath: "/tmp/cache",
    namespace: "infra",
  };
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () => Promise.resolve(configWithNs),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkUnmigratedData: () =>
      Promise.resolve({ unmigrated: true, directories: ["data", "outputs"] }),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const nsFinding = completed.data.healthFindings.find(
      (f) => f.check === "namespace_migration",
    );
    assertEquals(nsFinding?.passed, false);
    assertEquals(nsFinding?.message.includes("data, outputs"), true);
  }
});

Deno.test("doctorDatastores: passes when all data is under namespace", async () => {
  const configWithNs: DatastoreConfig = {
    type: "@swamp/s3-datastore",
    config: { bucket: "test" },
    datastorePath: "/tmp/cache",
    namespace: "infra",
  };
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () => Promise.resolve(configWithNs),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkUnmigratedData: () =>
      Promise.resolve({ unmigrated: false, directories: [] }),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const nsFinding = completed.data.healthFindings.find(
      (f) => f.check === "namespace_migration",
    );
    assertEquals(nsFinding?.passed, true);
  }
});

Deno.test("doctorDatastores: skips namespace check when no namespace configured", async () => {
  const deps = makeDeps(
    customConfig,
    { healthy: true, message: "OK", latencyMs: 1 },
    [],
  );

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const nsFinding = completed.data.healthFindings.find(
      (f) => f.check === "namespace_migration",
    );
    assertEquals(nsFinding, undefined);
  }
});
