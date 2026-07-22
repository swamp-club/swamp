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
  repairDatastoreContamination,
  type RepairDatastoresDeps,
  type RepairDatastoresEvent,
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

// ============================================================================
// Namespace contamination detection
// ============================================================================

const customConfigWithNs: DatastoreConfig = {
  type: "@swamp/s3-datastore",
  config: { bucket: "test" },
  datastorePath: "/tmp/cache",
  namespace: "dwh-infra",
};

Deno.test("doctorDatastores: detects namespace contamination", async () => {
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () => Promise.resolve(customConfigWithNs),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkNamespaceContamination: () =>
      Promise.resolve({
        foreignNamespaces: [
          { namespace: "asdlc", objectCount: 803 },
          { namespace: "swamp-extensions", objectCount: 13934 },
        ],
        totalForeignObjects: 14737,
        deleted: 0,
      }),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const cFinding = completed.data.healthFindings.find(
      (f) => f.check === "namespace_contamination",
    );
    assertEquals(cFinding?.passed, false);
    assertEquals(cFinding?.message.includes("14737"), true);

    assertEquals(
      completed.data.contaminationFinding?.totalForeignObjects,
      14737,
    );
    assertEquals(
      completed.data.contaminationFinding?.foreignNamespaces.length,
      2,
    );
  }
});

Deno.test("doctorDatastores: passes when no contamination found", async () => {
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () => Promise.resolve(customConfigWithNs),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkNamespaceContamination: () =>
      Promise.resolve({
        foreignNamespaces: [],
        totalForeignObjects: 0,
        deleted: 0,
      }),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const cFinding = completed.data.healthFindings.find(
      (f) => f.check === "namespace_contamination",
    );
    assertEquals(cFinding?.passed, true);
    assertEquals(completed.data.contaminationFinding, undefined);
  }
});

Deno.test("doctorDatastores: skips contamination check for filesystem datastores", async () => {
  const fsConfigWithNs: DatastoreConfig = {
    type: "filesystem",
    path: "/tmp/test-repo/.swamp",
    namespace: "my-ns",
  };
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () => Promise.resolve(fsConfigWithNs),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkNamespaceContamination: () => {
      throw new Error("should not be called for filesystem datastores");
    },
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const cFinding = completed.data.healthFindings.find(
      (f) => f.check === "namespace_contamination",
    );
    assertEquals(cFinding, undefined);
    assertEquals(completed.data.contaminationFinding, undefined);
  }
});

Deno.test("doctorDatastores: skips contamination check when no namespace", async () => {
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () => Promise.resolve(customConfig),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkNamespaceContamination: () => {
      throw new Error("should not be called without namespace");
    },
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.contaminationFinding, undefined);
  }
});

// ============================================================================
// Repair: namespace contamination cleanup
// ============================================================================

function makeRepairDeps(
  overrides: Partial<RepairDatastoresDeps> = {},
): RepairDatastoresDeps {
  return {
    getDatastoreConfig: () => Promise.resolve(customConfigWithNs),
    detectContamination: () =>
      Promise.resolve({
        foreignNamespaces: [
          { namespace: "asdlc", objectCount: 803 },
          { namespace: "swamp-extensions", objectCount: 13934 },
        ],
        totalForeignObjects: 14737,
        deleted: 0,
      }),
    deleteContamination: () =>
      Promise.resolve({
        foreignNamespaces: [
          { namespace: "asdlc", objectCount: 803 },
          { namespace: "swamp-extensions", objectCount: 13934 },
        ],
        totalForeignObjects: 14737,
        deleted: 14737,
      }),
    wipeLocalCache: () => Promise.resolve(),
    pullScoped: () => Promise.resolve(1500),
    invalidateWorkflowRunIndexes: () => Promise.resolve(3),
    invalidateCatalog: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("repairDatastoreContamination: preview mode shows what would be cleaned", async () => {
  const deps = makeRepairDeps();

  const events = await collect<RepairDatastoresEvent>(
    repairDatastoreContamination(createLibSwampContext(), deps, {
      confirm: false,
    }),
  );

  assertEquals(events[0].kind, "scanning");
  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");
  if (preview?.kind === "preview") {
    assertEquals(preview.namespace, "dwh-infra");
    assertEquals(preview.contamination.totalForeignObjects, 14737);
    assertEquals(preview.contamination.foreignNamespaces.length, 2);
  }
  assertEquals(events.find((e) => e.kind === "completed"), undefined);
});

Deno.test("repairDatastoreContamination: confirm mode executes full repair", async () => {
  const callLog: string[] = [];
  const deps = makeRepairDeps({
    deleteContamination: () => {
      callLog.push("deleteContamination");
      return Promise.resolve({
        foreignNamespaces: [
          { namespace: "asdlc", objectCount: 803 },
        ],
        totalForeignObjects: 803,
        deleted: 803,
      });
    },
    wipeLocalCache: () => {
      callLog.push("wipeLocalCache");
      return Promise.resolve();
    },
    pullScoped: () => {
      callLog.push("pullScoped");
      return Promise.resolve(500);
    },
    invalidateWorkflowRunIndexes: () => {
      callLog.push("invalidateWorkflowRunIndexes");
      return Promise.resolve(2);
    },
    invalidateCatalog: () => {
      callLog.push("invalidateCatalog");
      return Promise.resolve();
    },
  });

  const events = await collect<RepairDatastoresEvent>(
    repairDatastoreContamination(createLibSwampContext(), deps, {
      confirm: true,
    }),
  );

  // Verify correct execution order
  assertEquals(callLog, [
    "deleteContamination",
    "wipeLocalCache",
    "pullScoped",
    "invalidateWorkflowRunIndexes",
    "invalidateCatalog",
  ]);

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.namespace, "dwh-infra");
    assertEquals(completed.result.deletedObjects, 803);
    assertEquals(completed.result.filesPulled, 500);
    assertEquals(completed.result.workflowRunIndexesInvalidated, 2);
    assertEquals(completed.result.catalogInvalidated, true);
  }

  // Verify step events were emitted in order
  const steps = events.filter((e) => e.kind === "step");
  assertEquals(steps.length, 5);
  if (steps[0].kind === "step") {
    assertEquals(steps[0].step, 1);
  }
});

Deno.test("repairDatastoreContamination: not needed when no contamination", async () => {
  const deps = makeRepairDeps({
    detectContamination: () =>
      Promise.resolve({
        foreignNamespaces: [],
        totalForeignObjects: 0,
        deleted: 0,
      }),
  });

  const events = await collect<RepairDatastoresEvent>(
    repairDatastoreContamination(createLibSwampContext(), deps, {
      confirm: true,
    }),
  );

  assertEquals(events[0].kind, "scanning");
  assertEquals(events[1].kind, "not_needed");
  assertEquals(events.length, 2);
});

Deno.test("repairDatastoreContamination: not needed when no namespace configured", async () => {
  const deps = makeRepairDeps({
    getDatastoreConfig: () => Promise.resolve(customConfig),
  });

  const events = await collect<RepairDatastoresEvent>(
    repairDatastoreContamination(createLibSwampContext(), deps, {
      confirm: true,
    }),
  );

  assertEquals(events[0].kind, "scanning");
  assertEquals(events[1].kind, "not_needed");
});

Deno.test("repairDatastoreContamination: emits progress steps during confirm", async () => {
  const deps = makeRepairDeps();

  const events = await collect<RepairDatastoresEvent>(
    repairDatastoreContamination(createLibSwampContext(), deps, {
      confirm: true,
    }),
  );

  const steps = events.filter(
    (e): e is Extract<RepairDatastoresEvent, { kind: "step" }> =>
      e.kind === "step",
  );

  assertEquals(steps.length, 5);
  for (let i = 0; i < steps.length; i++) {
    assertEquals(steps[i].step, i + 1);
    assertEquals(steps[i].total, 5);
  }

  assertEquals(steps[0].description.includes("Deleting"), true);
  assertEquals(steps[1].description.includes("Wiping"), true);
  assertEquals(steps[2].description.includes("Re-pulling"), true);
  assertEquals(steps[3].description.includes("workflow run"), true);
  assertEquals(steps[4].description.includes("catalog"), true);
});

Deno.test("repairDatastoreContamination: yields error event on mid-repair failure", async () => {
  const deps = makeRepairDeps({
    pullScoped: () => Promise.reject(new Error("network timeout")),
  });

  const events = await collect<RepairDatastoresEvent>(
    repairDatastoreContamination(createLibSwampContext(), deps, {
      confirm: true,
    }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertEquals(errorEvent.error.code, "repair_failed");
    assertEquals(errorEvent.error.message.includes("step 3/5"), true);
    assertEquals(errorEvent.error.message.includes("network timeout"), true);
    assertEquals(
      errorEvent.error.message.includes("swamp datastore sync --pull"),
      true,
    );
  }
  assertEquals(events.find((e) => e.kind === "completed"), undefined);
});
