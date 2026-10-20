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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, SEPARATOR } from "@std/path";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  type CatalogCompletenessSummary,
  doctorDatastores,
  type DoctorDatastoresDeps,
  type DoctorDatastoresEvent,
  repairCatalogDuplicateLatest,
  type RepairCatalogDuplicateLatestEvent,
  repairCatalogIndex,
  type RepairCatalogIndexEvent,
  repairDatastoreContamination,
  type RepairDatastoresDeps,
  type RepairDatastoresEvent,
  repairUnmigratedData,
  type RepairUnmigratedDataDeps,
  type RepairUnmigratedDataEvent,
  type V3ContentSummary,
} from "./doctor_datastores.ts";
import {
  repairDatastoreFormatMarker,
  type RepairDatastoreFormatMarkerDeps,
  type RepairDatastoreFormatMarkerEvent,
  repairPreV3Records,
  type RepairPreV3RecordsDeps,
  type RepairPreV3RecordsEvent,
} from "./doctor_datastores.ts";
import { UserError } from "../../domain/errors.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { RetentionCheckSummary } from "./retention_check.ts";

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

// ============================================================================
// Repair: root-level unmigrated data cleanup
// ============================================================================

function makeUnmigratedDeps(
  overrides: Partial<RepairUnmigratedDataDeps> = {},
): RepairUnmigratedDataDeps {
  return {
    getBasePath: () => "/tmp/cache",
    getNamespace: () => "homelab",
    getDatastoreDirectories: () => [],
    listFiles: () => Promise.resolve([]),
    compareFiles: () => Promise.resolve(true),
    removeFile: () => Promise.resolve(),
    removeEmptyDirs: () => Promise.resolve(),
    dirExists: () => Promise.resolve(false),
    ...overrides,
  };
}

Deno.test("repairUnmigratedData: not needed when no root-level dirs have files", async () => {
  const deps = makeUnmigratedDeps();

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: true }),
  );

  assertEquals(events[0].kind, "scanning");
  assertEquals(events[1].kind, "not_needed");
  assertEquals(events.length, 2);
});

Deno.test("repairUnmigratedData: preview mode shows dirs without modifying", async () => {
  const removedFiles: string[] = [];
  const dataSuffix = `${SEPARATOR}data`;
  const outputsSuffix = `${SEPARATOR}outputs`;
  const deps = makeUnmigratedDeps({
    dirExists: (path) =>
      Promise.resolve(
        path.endsWith(dataSuffix) || path.endsWith(outputsSuffix),
      ),
    listFiles: (dir) => {
      if (dir.endsWith(dataSuffix)) {
        return Promise.resolve(["model/raw", "model/metadata.yaml"]);
      }
      if (dir.endsWith(outputsSuffix)) {
        return Promise.resolve(["report.yaml"]);
      }
      return Promise.resolve([]);
    },
    removeFile: (path) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
  });

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: false }),
  );

  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");
  if (preview?.kind === "preview") {
    assertEquals(preview.namespace, "homelab");
    assertEquals(preview.directories.includes("data"), true);
    assertEquals(preview.directories.includes("outputs"), true);
  }
  assertEquals(removedFiles.length, 0);
});

Deno.test("repairUnmigratedData: confirm removes identical duplicates", async () => {
  const removedFiles: string[] = [];
  const removedDirs: string[] = [];
  const dataSuffix = `${SEPARATOR}data`;

  const deps = makeUnmigratedDeps({
    dirExists: (path) => Promise.resolve(path.endsWith(dataSuffix)),
    listFiles: () => Promise.resolve(["model/raw", "model/metadata.yaml"]),
    compareFiles: () => Promise.resolve(true),
    removeFile: (path) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
    removeEmptyDirs: (dir) => {
      removedDirs.push(dir);
      return Promise.resolve();
    },
  });

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: true }),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.result.removedFiles, 2);
    assertEquals(completed.result.removedDirectories, ["data"]);
    assertEquals(completed.namespace, "homelab");
  }
  assertEquals(removedFiles.length, 2);
  assertEquals(removedFiles[0], join("/tmp/cache", "data", "model/raw"));
  assertEquals(
    removedFiles[1],
    join("/tmp/cache", "data", "model/metadata.yaml"),
  );
  assertEquals(removedDirs.length, 1);
  assertEquals(removedDirs[0], join("/tmp/cache", "data"));
});

Deno.test("repairUnmigratedData: errors on non-identical files without deleting anything", async () => {
  const removedFiles: string[] = [];
  const dataSuffix = `${SEPARATOR}data`;

  const deps = makeUnmigratedDeps({
    dirExists: (path) => Promise.resolve(path.endsWith(dataSuffix)),
    listFiles: () => Promise.resolve(["model/raw"]),
    compareFiles: () => Promise.resolve(false),
    removeFile: (path) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
  });

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: true }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertEquals(errorEvent.error.code, "non_identical_unmigrated_data");
    assertStringIncludes(errorEvent.error.message, "differ from");
    assertStringIncludes(
      errorEvent.error.message,
      "namespace migrate --confirm",
    );
  }
  assertEquals(removedFiles.length, 0);
});

Deno.test("repairUnmigratedData: handles multiple dirs, stops on first non-identical", async () => {
  const removedFiles: string[] = [];
  const dataSuffix = `${SEPARATOR}data`;
  const outputsSuffix = `${SEPARATOR}outputs`;

  const deps = makeUnmigratedDeps({
    dirExists: (path) =>
      Promise.resolve(
        path.endsWith(dataSuffix) || path.endsWith(outputsSuffix),
      ),
    listFiles: (dir) => {
      if (dir.endsWith(dataSuffix)) {
        return Promise.resolve(["file1.yaml"]);
      }
      if (dir.endsWith(outputsSuffix)) {
        return Promise.resolve(["report.yaml"]);
      }
      return Promise.resolve([]);
    },
    compareFiles: (_a, b) => {
      if (b.includes(`${SEPARATOR}outputs${SEPARATOR}`)) {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    },
    removeFile: (path) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
  });

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: true }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertStringIncludes(errorEvent.error.message, "outputs");
  }
});

Deno.test("repairUnmigratedData: emits step events during confirm", async () => {
  const dataSuffix = `${SEPARATOR}data`;
  const outputsSuffix = `${SEPARATOR}outputs`;
  const deps = makeUnmigratedDeps({
    dirExists: (path) =>
      Promise.resolve(
        path.endsWith(dataSuffix) || path.endsWith(outputsSuffix),
      ),
    listFiles: () => Promise.resolve(["file.yaml"]),
    compareFiles: () => Promise.resolve(true),
  });

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: true }),
  );

  const steps = events.filter(
    (e): e is Extract<RepairUnmigratedDataEvent, { kind: "step" }> =>
      e.kind === "step",
  );
  assertEquals(steps.length, 2);
  assertStringIncludes(steps[0].description, "data/");
  assertStringIncludes(steps[1].description, "outputs/");
});

// ============================================================================
// Catalog completeness check and repair (swamp-club#1580)
// ============================================================================

const completeSummary: CatalogCompletenessSummary = {
  diskRecords: 42,
  catalogRecords: 42,
  shortfalls: [],
};

const shortSummary: CatalogCompletenessSummary = {
  diskRecords: 330,
  catalogRecords: 16,
  shortfalls: [
    {
      typeNormalized: "@keeb/rottentomatoes",
      diskRecords: 314,
      catalogRecords: 0,
    },
  ],
};

Deno.test("doctorDatastores: reports a complete catalog as passing", async () => {
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(
      filesystemConfig,
      { healthy: true, message: "Datastore is accessible", latencyMs: 1 },
      [],
    ),
    checkCatalogCompleteness: () => Promise.resolve(completeSummary),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const finding = completed.data.healthFindings.find(
      (f) => f.check === "catalog_completeness",
    );
    assertEquals(finding?.passed, true);
    assertStringIncludes(finding?.message ?? "", "42");
    assertEquals(completed.data.catalogCompletenessFinding, undefined);
  }
});

Deno.test("doctorDatastores: reports a short catalog and names the remedy", async () => {
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(
      filesystemConfig,
      { healthy: true, message: "Datastore is accessible", latencyMs: 1 },
      [],
    ),
    checkCatalogCompleteness: () => Promise.resolve(shortSummary),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const finding = completed.data.healthFindings.find(
      (f) => f.check === "catalog_completeness",
    );
    assertEquals(finding?.passed, false);
    assertStringIncludes(finding?.message ?? "", "314");
    assertStringIncludes(
      finding?.message ?? "",
      "swamp doctor datastores --repair",
    );
    assertEquals(
      completed.data.catalogCompletenessFinding?.shortfalls.length,
      1,
    );
  }
});

// The catalog is a local index. A plain local repo with no namespace and no
// remote datastore is exactly where an incomplete one goes unnoticed, so the
// check must not be gated the way the migration and contamination checks are.
Deno.test("doctorDatastores: catalog check runs without a namespace or custom datastore", async () => {
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(
      filesystemConfig,
      { healthy: true, message: "Datastore is accessible", latencyMs: 1 },
      [],
    ),
    checkCatalogCompleteness: () => Promise.resolve(shortSummary),
    checkUnmigratedData: () =>
      Promise.resolve({ unmigrated: false, directories: [] }),
    checkNamespaceContamination: () => Promise.resolve(null),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.isCustom, false);
    // No namespace configured, so neither namespace check contributed.
    assertEquals(
      completed.data.healthFindings.some((f) =>
        f.check === "namespace_migration"
      ),
      false,
    );
    assertEquals(
      completed.data.healthFindings.some((f) =>
        f.check === "catalog_completeness"
      ),
      true,
    );
  }
});

Deno.test("repairCatalogIndex: no shortfall means nothing to repair", async () => {
  let invalidated = 0;
  const events = await collect<RepairCatalogIndexEvent>(
    repairCatalogIndex(
      createLibSwampContext(),
      {
        checkCompleteness: () => Promise.resolve(completeSummary),
        invalidateCatalog: () => {
          invalidated++;
          return Promise.resolve();
        },
      },
      { confirm: true },
    ),
  );

  assertEquals(events.some((e) => e.kind === "not_needed"), true);
  assertEquals(invalidated, 0, "a healthy catalog must not be deleted");
});

Deno.test("repairCatalogIndex: previews without deleting when not confirmed", async () => {
  let invalidated = 0;
  const events = await collect<RepairCatalogIndexEvent>(
    repairCatalogIndex(
      createLibSwampContext(),
      {
        checkCompleteness: () => Promise.resolve(shortSummary),
        invalidateCatalog: () => {
          invalidated++;
          return Promise.resolve();
        },
      },
      { confirm: false },
    ),
  );

  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");
  if (preview?.kind === "preview") {
    assertEquals(preview.completeness.shortfalls.length, 1);
  }
  assertEquals(invalidated, 0, "preview must not touch the catalog");
});

Deno.test("repairCatalogIndex: invalidates the catalog exactly once when confirmed", async () => {
  const callLog: string[] = [];
  const events = await collect<RepairCatalogIndexEvent>(
    repairCatalogIndex(
      createLibSwampContext(),
      {
        checkCompleteness: () => {
          callLog.push("checkCompleteness");
          return Promise.resolve(shortSummary);
        },
        invalidateCatalog: () => {
          callLog.push("invalidateCatalog");
          return Promise.resolve();
        },
      },
      { confirm: true },
    ),
  );

  assertEquals(callLog, ["checkCompleteness", "invalidateCatalog"]);
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.result.missingRecords, 314);
    assertEquals(completed.result.shortfalls.length, 1);
  }
});

Deno.test("repairCatalogIndex: reports a failed deletion without claiming success", async () => {
  const events = await collect<RepairCatalogIndexEvent>(
    repairCatalogIndex(
      createLibSwampContext(),
      {
        checkCompleteness: () => Promise.resolve(shortSummary),
        invalidateCatalog: () =>
          Promise.reject(new Deno.errors.PermissionDenied("locked")),
      },
      { confirm: true },
    ),
  );

  assertEquals(events.some((e) => e.kind === "completed"), false);
  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertStringIncludes(errorEvent.error.message, "No changes were made");
  }
});

// --- repairCatalogDuplicateLatest tests ---

Deno.test("repairCatalogDuplicateLatest: not_needed when no duplicates", async () => {
  const events = await collect<RepairCatalogDuplicateLatestEvent>(
    repairCatalogDuplicateLatest(
      createLibSwampContext(),
      {
        countDuplicateLatest: () => 0,
        enforceUniqueLatest: () => 0,
      },
      { confirm: true },
    ),
  );

  assertEquals(events.some((e) => e.kind === "not_needed"), true);
  assertEquals(events.some((e) => e.kind === "completed"), false);
});

Deno.test("repairCatalogDuplicateLatest: preview without confirm", async () => {
  const events = await collect<RepairCatalogDuplicateLatestEvent>(
    repairCatalogDuplicateLatest(
      createLibSwampContext(),
      {
        countDuplicateLatest: () => 3,
        enforceUniqueLatest: () => 3,
      },
      { confirm: false },
    ),
  );

  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");
  if (preview?.kind === "preview") {
    assertEquals(preview.duplicateCount, 3);
  }
  assertEquals(events.some((e) => e.kind === "completed"), false);
});

Deno.test("repairCatalogDuplicateLatest: repairs with confirm", async () => {
  const callLog: string[] = [];
  const events = await collect<RepairCatalogDuplicateLatestEvent>(
    repairCatalogDuplicateLatest(
      createLibSwampContext(),
      {
        countDuplicateLatest: () => {
          callLog.push("count");
          return 2;
        },
        enforceUniqueLatest: () => {
          callLog.push("enforce");
          return 5;
        },
      },
      { confirm: true },
    ),
  );

  assertEquals(callLog, ["count", "enforce"]);
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.result.demotedRows, 5);
  }
});

Deno.test("doctorDatastores: reports a namespace named after a layout directory and skips the un-migrated data check", async () => {
  let unmigratedChecked = false;
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () =>
      Promise.resolve({ ...filesystemConfig, namespace: "data" }),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
    checkUnmigratedData: () => {
      unmigratedChecked = true;
      return Promise.resolve({ unmigrated: true, directories: ["data"] });
    },
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const reserved = completed.data.healthFindings.find(
      (f) => f.check === "reserved_namespace",
    );
    assertEquals(reserved?.passed, false);
    assertStringIncludes(
      reserved?.message ?? "",
      'Namespace "data" has the same name as a datastore layout directory',
    );
    assertEquals(
      completed.data.healthFindings.some((f) =>
        f.check === "namespace_migration"
      ),
      false,
    );
  }
  assertEquals(unmigratedChecked, false);
});

Deno.test("doctorDatastores: reports a namespace equal to a configured datastore directory", async () => {
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () =>
      Promise.resolve({
        ...filesystemConfig,
        directories: ["data", "scratch"],
        namespace: "scratch",
      }),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(
      completed.data.healthFindings.find((f) =>
        f.check === "reserved_namespace"
      )?.passed,
      false,
    );
  }
});

Deno.test("doctorDatastores: no reserved_namespace finding for an ordinary namespace", async () => {
  const deps: DoctorDatastoresDeps = {
    getDatastoreConfig: () =>
      Promise.resolve({ ...filesystemConfig, namespace: "infra" }),
    checkHealth: () =>
      Promise.resolve({ healthy: true, message: "OK", latencyMs: 1 }),
    getVaultConfigs: () => Promise.resolve([]),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(
      completed.data.healthFindings.some((f) =>
        f.check === "reserved_namespace"
      ),
      false,
    );
  }
});

Deno.test("repairUnmigratedData: refuses a namespace named after a layout directory without removing anything", async () => {
  const removedFiles: string[] = [];
  const deps = makeUnmigratedDeps({
    getNamespace: () => "data",
    dirExists: () => Promise.resolve(true),
    listFiles: () => Promise.resolve(["model/raw"]),
    removeFile: (path) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
  });

  const events = await collect<RepairUnmigratedDataEvent>(
    repairUnmigratedData(createLibSwampContext(), deps, { confirm: true }),
  );

  assertEquals(events.map((e) => e.kind), ["scanning", "error"]);
  const error = events[1];
  if (error.kind === "error") {
    assertEquals(error.error.code, "validation_failed");
  }
  assertEquals(removedFiles, []);
});

function retentionSummary(
  overrides: Partial<RetentionCheckSummary> = {},
): RetentionCheckSummary {
  return {
    configured: true,
    automatic: true,
    checkedAt: "2026-10-15T00:00:00.000Z",
    kinds: [],
    ...overrides,
  };
}

function retentionFinding(events: DoctorDatastoresEvent[]) {
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") throw new Error("no completed event");
  return {
    finding: completed.data.healthFindings.find((f) => f.check === "retention"),
    summary: completed.data.retentionFinding,
  };
}

Deno.test("doctorDatastores: runs the retention check only with the retention option", async () => {
  let calls = 0;
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(filesystemConfig, {
      healthy: true,
      message: "ok",
      latencyMs: 1,
    }, []),
    checkRetention: () => {
      calls++;
      return Promise.resolve(retentionSummary());
    },
  };

  const without = retentionFinding(
    await collect<DoctorDatastoresEvent>(
      doctorDatastores(createLibSwampContext(), deps),
    ),
  );
  assertEquals(calls, 0);
  assertEquals(without.finding, undefined);
  assertEquals(without.summary, undefined);

  const withCheck = retentionFinding(
    await collect<DoctorDatastoresEvent>(
      doctorDatastores(createLibSwampContext(), deps, { retention: true }),
    ),
  );
  assertEquals(calls, 1);
  assertEquals(withCheck.finding?.passed, true);
  assertEquals(withCheck.summary?.configured, true);
});

Deno.test("doctorDatastores: the retention check passes with a message when retention is not configured", async () => {
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(filesystemConfig, {
      healthy: true,
      message: "ok",
      latencyMs: 1,
    }, []),
    checkRetention: () =>
      Promise.resolve(retentionSummary({ configured: false })),
  };
  const { finding } = retentionFinding(
    await collect<DoctorDatastoresEvent>(
      doctorDatastores(createLibSwampContext(), deps, { retention: true }),
    ),
  );
  assertEquals(finding?.passed, true);
  assertStringIncludes(finding!.message, "not configured");
});

Deno.test("doctorDatastores: the retention check fails on overdue items or v3 history past its bound", async () => {
  const overdueKind = {
    kind: "workflowRuns" as const,
    retention: "30d",
    cutoff: "2026-09-15T00:00:00.000Z",
    scanned: true,
    overdue: 2,
    items: [],
    kept: 0,
    watermark: null,
  };
  for (
    const summary of [
      retentionSummary({ kinds: [overdueKind] }),
      retentionSummary({
        v3History: {
          oldestCommitAt: "2026-09-01T00:00:00.000Z",
          compactionBound: "2026-10-08T00:00:00.000Z",
          failBefore: "2026-10-07T00:00:00.000Z",
          overdue: true,
        },
      }),
    ]
  ) {
    const deps: DoctorDatastoresDeps = {
      ...makeDeps(filesystemConfig, {
        healthy: true,
        message: "ok",
        latencyMs: 1,
      }, []),
      checkRetention: () => Promise.resolve(summary),
    };
    const { finding } = retentionFinding(
      await collect<DoctorDatastoresEvent>(
        doctorDatastores(createLibSwampContext(), deps, { retention: true }),
      ),
    );
    assertEquals(finding?.passed, false);
  }
});

// --- swamp-club#3617: restoring a v3 datastore's lost format marker ---

function markerRepairDeps(
  state: "absent" | "blank" | undefined,
  restore: () => Promise<string>,
): RepairDatastoreFormatMarkerDeps {
  return {
    datastorePath: "/data/v3",
    markerPath: "/data/v3/datastore-format.json",
    inspect: () => Promise.resolve(state),
    restore,
  };
}

Deno.test("repairDatastoreFormatMarker: previews a lost marker without restoring it (swamp-club#3617)", async () => {
  let restored = false;
  const events = await collect<RepairDatastoreFormatMarkerEvent>(
    repairDatastoreFormatMarker(
      createLibSwampContext(),
      markerRepairDeps("blank", () => {
        restored = true;
        return Promise.resolve("/data/v3/datastore-format.json");
      }),
      { confirm: false },
    ),
  );
  assertEquals(events, [
    { kind: "inspecting" },
    {
      kind: "preview",
      data: {
        datastorePath: "/data/v3",
        markerPath: "/data/v3/datastore-format.json",
        marker: "blank",
      },
    },
  ]);
  assertEquals(restored, false);
});

Deno.test("repairDatastoreFormatMarker: restores with confirm, and reports a marker that is not lost (swamp-club#3617)", async () => {
  const events = await collect<RepairDatastoreFormatMarkerEvent>(
    repairDatastoreFormatMarker(
      createLibSwampContext(),
      markerRepairDeps("absent", () => Promise.resolve("/data/v3/m.json")),
      { confirm: true },
    ),
  );
  assertEquals(events.at(-1), {
    kind: "completed",
    data: {
      datastorePath: "/data/v3",
      markerPath: "/data/v3/m.json",
      marker: "absent",
    },
  });
  const none = await collect<RepairDatastoreFormatMarkerEvent>(
    repairDatastoreFormatMarker(
      createLibSwampContext(),
      markerRepairDeps(undefined, () => Promise.reject(new Error("no"))),
      { confirm: true },
    ),
  );
  assertEquals(none.at(-1), { kind: "not_needed", datastorePath: "/data/v3" });
});

Deno.test("repairDatastoreFormatMarker: a refused restore is an error event carrying its code (swamp-club#3617)", async () => {
  const refusal = new UserError("not restored", "some_code");
  const events = await collect<RepairDatastoreFormatMarkerEvent>(
    repairDatastoreFormatMarker(
      createLibSwampContext(),
      markerRepairDeps("absent", () => Promise.reject(refusal)),
      { confirm: true },
    ),
  );
  const last = events.at(-1);
  assertEquals(last?.kind, "error");
  if (last?.kind !== "error") return;
  assertEquals(last.error.code, "some_code");
  assertEquals(last.error.message, "not restored");
  const plain = await collect<RepairDatastoreFormatMarkerEvent>(
    repairDatastoreFormatMarker(
      createLibSwampContext(),
      markerRepairDeps("absent", () => Promise.reject(new Error("disk"))),
      { confirm: true },
    ),
  );
  const failed = plain.at(-1);
  assertEquals(
    failed?.kind === "error" ? failed.error.code : undefined,
    "format_marker_repair_failed",
  );
});

const CLEAN_V3_CONTENT: V3ContentSummary = {
  unreadableRecords: 0,
  unreadable: [],
  atRiskCopies: 0,
  atRisk: [],
  atRiskDir: "/repo/.swamp/_read_model_v3/at-risk",
  atRiskAdvice: "delete it to discard them",
  tornChunks: 0,
  torn: [],
};

async function v3ContentScan(
  summary: V3ContentSummary | undefined,
): Promise<{
  findings: { check: string; passed: boolean; message: string }[];
  data: unknown;
  configs: DatastoreConfig[];
}> {
  const configs: DatastoreConfig[] = [];
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(
      filesystemConfig,
      { healthy: true, message: "ok", latencyMs: 1 },
      [],
    ),
    ...(summary !== undefined
      ? {
        checkV3Content: (config: DatastoreConfig) => {
          configs.push(config);
          return Promise.resolve(summary);
        },
      }
      : {}),
  };
  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") throw new Error("no completed event");
  return {
    findings: completed.data.healthFindings,
    data: completed.data.v3ContentFinding,
    configs,
  };
}

Deno.test("doctorDatastores: the v3 content check passes on a clean checkout, and is absent without the dependency (swamp-club#3617)", async () => {
  const clean = await v3ContentScan(CLEAN_V3_CONTENT);
  const finding = clean.findings.find((f) => f.check === "v3_content");
  assertEquals(finding?.passed, true);
  assertEquals(clean.data, undefined);
  assertEquals(clean.configs, [filesystemConfig]);

  const v2 = await v3ContentScan(undefined);
  assertEquals(v2.findings.some((f) => f.check === "v3_content"), false);
});

Deno.test("doctorDatastores: the v3 content check fails with counts and first keys for unreadable records, at-risk copies and torn chunks (swamp-club#3617)", async () => {
  const summary: V3ContentSummary = {
    ...CLEAN_V3_CONTENT,
    unreadableRecords: 5,
    unreadable: ["a", "b", "c", "d"].map((name) => ({
      namespace: "",
      recordKey: `data/m/${name}/1/raw`,
      reason: "missing" as const,
      advice: "write that data again",
    })),
    atRiskCopies: 1,
    atRisk: [{
      namespace: "",
      sha256: "b".repeat(64),
      recordKey: "outputs/m/out.yaml",
      size: 9,
    }],
    tornChunks: 1,
    torn: [{
      namespace: "",
      sha256: "c".repeat(64),
      recordKey: "data/m/torn/1/raw",
      expectedSize: 10,
      size: 3,
      advice: "write it again",
    }],
  };
  const scan = await v3ContentScan(summary);
  const finding = scan.findings.find((f) => f.check === "v3_content");
  assertEquals(finding?.passed, false);
  assertEquals(scan.data, summary);
  const message = finding?.message ?? "";
  assertStringIncludes(
    message,
    "5 record(s) cannot be read: a chunk is missing or damaged in the datastore (data/m/a/1/raw, data/m/b/1/raw, data/m/c/1/raw and 2 more)",
  );
  assertStringIncludes(
    message,
    "1 checkout file(s) were moved aside into /repo/.swamp/_read_model_v3/at-risk",
  );
  assertStringIncludes(message, "outputs/m/out.yaml");
  assertStringIncludes(
    message,
    "1 chunk(s) the checkout's records name are stored short (data/m/torn/1/raw)",
  );
});

Deno.test("doctorDatastores: a v3 content check that throws is a failed finding, and the scan completes (swamp-club#3617)", async () => {
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(
      filesystemConfig,
      { healthy: true, message: "Datastore is accessible", latencyMs: 1 },
      [],
    ),
    checkV3Content: () =>
      Promise.reject(new Error("attempt to write a readonly database")),
  };
  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(
      completed.data.healthFindings.map((f) => [f.check, f.passed]),
      [["health", true], ["v3_content", false]],
    );
    assertEquals(
      completed.data.healthFindings[1].message,
      "Could not inspect this v3 checkout's content: attempt to write a readonly database",
    );
    assertEquals(completed.data.v3ContentFinding, undefined);
  }
});

// --- swamp-club#3690: moving aside a joining checkout's records ---

function preV3Deps(
  found: string[],
  moveAside: RepairPreV3RecordsDeps["moveAside"],
): RepairPreV3RecordsDeps {
  return {
    swampDir: "/repo/.swamp",
    preV3RecordsDir: "/repo/.swamp/pre-v3-records",
    inspect: () => Promise.resolve(found),
    moveAside,
  };
}

Deno.test("repairPreV3Records: previews the records found without moving them (swamp-club#3690)", async () => {
  let moved = false;
  const events = await collect<RepairPreV3RecordsEvent>(
    repairPreV3Records(
      createLibSwampContext(),
      preV3Deps(["data", "outputs"], () => {
        moved = true;
        return Promise.resolve({ destination: "/x", moved: [] });
      }),
      { confirm: false },
    ),
  );
  assertEquals(events, [
    { kind: "inspecting" },
    {
      kind: "preview",
      data: {
        swampDir: "/repo/.swamp",
        recordDirs: ["data", "outputs"],
        preV3RecordsDir: "/repo/.swamp/pre-v3-records",
      },
    },
  ]);
  assertEquals(moved, false);
});

Deno.test("repairPreV3Records: moves with confirm, reports where to, and reports a checkout with nothing to move (swamp-club#3690)", async () => {
  const destination = "/repo/.swamp/pre-v3-records/20261020T211321Z-abcd1234";
  const events = await collect<RepairPreV3RecordsEvent>(
    repairPreV3Records(
      createLibSwampContext(),
      preV3Deps(
        ["data"],
        () => Promise.resolve({ destination, moved: ["data"] }),
      ),
      { confirm: true },
    ),
  );
  assertEquals(events.at(-1), {
    kind: "completed",
    data: {
      swampDir: "/repo/.swamp",
      recordDirs: ["data"],
      preV3RecordsDir: "/repo/.swamp/pre-v3-records",
      destination,
    },
  });
  const none = await collect<RepairPreV3RecordsEvent>(
    repairPreV3Records(
      createLibSwampContext(),
      preV3Deps([], () => Promise.reject(new Error("must not move"))),
      { confirm: true },
    ),
  );
  assertEquals(none.at(-1), { kind: "not_needed", swampDir: "/repo/.swamp" });
});

Deno.test("repairPreV3Records: a move that fails says the moved directories stay moved and a re-run moves the rest (swamp-club#3690)", async () => {
  const events = await collect<RepairPreV3RecordsEvent>(
    repairPreV3Records(
      createLibSwampContext(),
      preV3Deps(["data"], () => Promise.reject(new Error("EBUSY"))),
      { confirm: true },
    ),
  );
  const last = events.at(-1);
  assertEquals(last?.kind, "error");
  if (last?.kind !== "error") return;
  assertEquals(last.error.code, "pre_v3_records_repair_failed");
  assertStringIncludes(last.error.message, "EBUSY");
  assertStringIncludes(last.error.message, "run the repair again");
  assertStringIncludes(last.error.message, "a new directory");
});

Deno.test("repairPreV3Records: records gone by the time they would move are reported as nothing to do (swamp-club#3690)", async () => {
  const events = await collect<RepairPreV3RecordsEvent>(
    repairPreV3Records(
      createLibSwampContext(),
      preV3Deps(
        ["data"],
        () => Promise.resolve({ destination: "/x", moved: [] }),
      ),
      { confirm: true },
    ),
  );
  assertEquals(events.at(-1), { kind: "not_needed", swampDir: "/repo/.swamp" });
});

Deno.test("doctorDatastores: reports a v3 checkout bound to a reserved namespace with the v3 way off it, and survives its open refusal (swamp-club#3691)", async () => {
  const v3Config: DatastoreConfig = {
    ...filesystemConfig,
    namespace: "vault",
    format: 3,
  };
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(v3Config, { healthy: true, message: "OK", latencyMs: 1 }, []),
    // What the read-only repository context's open throws on this binding.
    checkRetention: () =>
      Promise.reject(
        new UserError(
          'Namespace "vault" has the same name as a datastore layout ' +
            "directory or a directory swamp keeps in .swamp/. A v3 checkout " +
            "does not open on this namespace.",
        ),
      ),
  };

  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps, { retention: true }),
  );
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    const reserved = completed.data.healthFindings.find(
      (f) => f.check === "reserved_namespace",
    );
    assertEquals(reserved?.passed, false);
    assertStringIncludes(reserved?.message ?? "", 'Namespace "vault"');
    assertStringIncludes(reserved?.message ?? "", "new, empty v3 datastore");
    assertEquals(
      (reserved?.message ?? "").includes("swamp datastore namespace set"),
      false,
    );
    const retention = completed.data.healthFindings.find(
      (f) => f.check === "retention",
    );
    assertEquals(retention?.passed, false);
    assertStringIncludes(retention?.message ?? "", "does not open");
  }
});

Deno.test("doctorDatastores: reports a v3 checkout whose directories changed as a finding, and skips the retention check that would open it (swamp-club#3691)", async () => {
  const refusal =
    "Changing directories on an existing v3 checkout is not supported yet";
  let retentionCalls = 0;
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(filesystemConfig, {
      healthy: true,
      message: "ok",
      latencyMs: 1,
    }, []),
    checkV3Filter: () => Promise.resolve(refusal),
    checkRetention: () => {
      retentionCalls++;
      return Promise.reject(new UserError(refusal));
    },
  };
  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps, { retention: true }),
  );
  const completed = events.at(-1);
  if (completed?.kind !== "completed") throw new Error("expected completed");
  const finding = completed.data.healthFindings.find((f) =>
    f.check === "v3_directories"
  );
  assertEquals(finding?.passed, false);
  assertStringIncludes(finding!.message, refusal);
  assertEquals(retentionCalls, 0);
  const skipped = completed.data.healthFindings.find((f) =>
    f.check === "retention"
  );
  assertEquals(skipped?.passed, false);
  assertStringIncludes(skipped?.message ?? "", "v3_directories");

  const passing = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), {
      ...deps,
      checkV3Filter: () => Promise.resolve(undefined),
      checkRetention: () => Promise.resolve(retentionSummary()),
    }),
  );
  const done = passing.at(-1);
  if (done?.kind !== "completed") throw new Error("expected completed");
  assertEquals(
    done.data.healthFindings.find((f) => f.check === "v3_directories")
      ?.passed,
    true,
  );
});

Deno.test("doctorDatastores: a v3 filter it cannot read fails that check alone, and the other checks still report (swamp-club#3691)", async () => {
  const deps: DoctorDatastoresDeps = {
    ...makeDeps(filesystemConfig, {
      healthy: true,
      message: "ok",
      latencyMs: 1,
    }, []),
    checkV3Filter: () =>
      Promise.reject(new Error("attempt to write a readonly database")),
  };
  const events = await collect<DoctorDatastoresEvent>(
    doctorDatastores(createLibSwampContext(), deps, {}),
  );
  const completed = events.at(-1);
  if (completed?.kind !== "completed") throw new Error("expected completed");
  const finding = completed.data.healthFindings.find((f) =>
    f.check === "v3_directories"
  );
  assertEquals(finding?.passed, false);
  assertStringIncludes(finding!.message, "readonly database");
  assert(completed.data.healthFindings.length > 1);
});

Deno.test("doctorDatastores: a v2 repo bound to a name reserved for swamp's .swamp/ directories is not reported; a v3 one is (swamp-club#3691)", async () => {
  const reservedFinding = async (config: DatastoreConfig) => {
    const events = await collect<DoctorDatastoresEvent>(
      doctorDatastores(
        createLibSwampContext(),
        makeDeps(config, { healthy: true, message: "OK", latencyMs: 1 }, []),
        {},
      ),
    );
    const completed = events.at(-1);
    if (completed?.kind !== "completed") throw new Error("expected completed");
    return completed.data.healthFindings.find((f) =>
      f.check === "reserved_namespace"
    );
  };
  const v2 = { ...filesystemConfig, namespace: "workflows" };
  assertEquals(await reservedFinding(v2), undefined);
  const v3 = await reservedFinding({ ...v2, format: 3 });
  assertEquals(v3?.passed, false);
  assertStringIncludes(v3?.message ?? "", "new, empty v3 datastore");
});
