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

import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { NamespaceContaminationSummary } from "../../domain/datastore/datastore_sync_service.ts";

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Result of a single health check within the datastore doctor scan. */
export interface DatastoreHealthFinding {
  check: string;
  passed: boolean;
  message: string;
}

/** A vault whose type is incompatible with a remote datastore. */
export interface VaultMismatchFinding {
  vaultName: string;
  vaultType: string;
}

/** Foreign namespace objects detected under the repo's own namespace. */
export interface NamespaceContaminationFinding {
  foreignNamespaces: ReadonlyArray<{ namespace: string; objectCount: number }>;
  totalForeignObjects: number;
}

/** Outcome of a `doctor datastores` scan. */
export interface DoctorDatastoresData {
  datastoreType: string;
  isCustom: boolean;
  healthFindings: DatastoreHealthFinding[];
  vaultMismatchFindings: VaultMismatchFinding[];
  contaminationFinding?: NamespaceContaminationFinding;
}

export type DoctorDatastoresEvent =
  | { kind: "scanning" }
  | { kind: "completed"; data: DoctorDatastoresData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the `doctor datastores` scan. */
export interface DoctorDatastoresDeps {
  getDatastoreConfig: () => Promise<DatastoreConfig>;
  checkHealth: (
    config: DatastoreConfig,
  ) => Promise<{ healthy: boolean; message: string; latencyMs: number }>;
  getVaultConfigs: () => Promise<Array<{ name: string; type: string }>>;
  checkUnmigratedData?: (
    config: DatastoreConfig,
  ) => Promise<{ unmigrated: boolean; directories: string[] }>;
  checkNamespaceContamination?: (
    config: DatastoreConfig,
  ) => Promise<NamespaceContaminationSummary | null>;
}

/**
 * Diagnostic scan that checks:
 * 1. The configured datastore is reachable (health check).
 * 2. When a namespace is set, data has been migrated under it.
 * 3. When a namespace is set, no foreign namespace data is nested under it.
 * 4. When a custom (remote) datastore is in use, any `local_encryption`
 *    vaults are flagged as an advisory mismatch.
 */
export async function* doctorDatastores(
  _ctx: LibSwampContext,
  deps: DoctorDatastoresDeps,
): AsyncGenerator<DoctorDatastoresEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const config = await deps.getDatastoreConfig();
      const isCustom = isCustomDatastoreConfig(config);
      const healthFindings: DatastoreHealthFinding[] = [];
      const vaultMismatchFindings: VaultMismatchFinding[] = [];
      let contaminationFinding: NamespaceContaminationFinding | undefined;

      // Health check
      const { healthy, message } = await deps.checkHealth(config);
      healthFindings.push({
        check: "health",
        passed: healthy,
        message,
      });

      // Un-migrated namespace data check
      if (config.namespace && deps.checkUnmigratedData) {
        const result = await deps.checkUnmigratedData(config);
        if (result.unmigrated) {
          healthFindings.push({
            check: "namespace_migration",
            passed: false,
            message:
              `Un-migrated data found at root level (${
                result.directories.join(", ")
              }). ` +
              `Run 'swamp datastore namespace migrate' to preview, then --confirm to move data ` +
              `under the "${config.namespace}" namespace.`,
          });
        } else {
          healthFindings.push({
            check: "namespace_migration",
            passed: true,
            message: `All data is under namespace "${config.namespace}"`,
          });
        }
      }

      // Namespace contamination check
      if (config.namespace && isCustom && deps.checkNamespaceContamination) {
        const summary = await deps.checkNamespaceContamination(config);
        if (summary && summary.totalForeignObjects > 0) {
          contaminationFinding = {
            foreignNamespaces: summary.foreignNamespaces,
            totalForeignObjects: summary.totalForeignObjects,
          };
          healthFindings.push({
            check: "namespace_contamination",
            passed: false,
            message:
              `Namespace contamination detected: ${summary.totalForeignObjects} foreign objects ` +
              `found under "${config.namespace}". ` +
              `Run 'swamp doctor datastores --repair' to preview cleanup.`,
          });
        } else if (summary) {
          healthFindings.push({
            check: "namespace_contamination",
            passed: true,
            message: `No foreign namespace data under "${config.namespace}"`,
          });
        }
      }

      // Vault mismatch check — only relevant for custom (remote) datastores
      if (isCustom) {
        const vaults = await deps.getVaultConfigs();
        for (const vault of vaults) {
          if (vault.type === "local_encryption") {
            vaultMismatchFindings.push({
              vaultName: vault.name,
              vaultType: vault.type,
            });
          }
        }
      }

      yield {
        kind: "completed",
        data: {
          datastoreType: config.type,
          isCustom,
          healthFindings,
          vaultMismatchFindings,
          contaminationFinding,
        },
      };
    })(),
  );
}

// ============================================================================
// Repair: namespace contamination cleanup
// ============================================================================

/** Outcome of a completed repair operation. */
export interface RepairDatastoresResult {
  foreignNamespaces: ReadonlyArray<{ namespace: string; objectCount: number }>;
  deletedObjects: number;
  filesPulled: number;
  workflowRunIndexesInvalidated: number;
  catalogInvalidated: boolean;
}

export type RepairDatastoresEvent =
  | { kind: "scanning" }
  | {
    kind: "preview";
    contamination: NamespaceContaminationFinding;
    namespace: string;
  }
  | { kind: "step"; step: number; total: number; description: string }
  | {
    kind: "completed";
    result: RepairDatastoresResult;
    namespace: string;
  }
  | { kind: "not_needed" }
  | { kind: "error"; error: SwampError };

/** Dependencies for the repair flow. */
export interface RepairDatastoresDeps {
  getDatastoreConfig: () => Promise<DatastoreConfig>;
  detectContamination: () => Promise<NamespaceContaminationSummary>;
  deleteContamination: () => Promise<NamespaceContaminationSummary>;
  wipeLocalCache: () => Promise<void>;
  pullScoped: () => Promise<number>;
  invalidateWorkflowRunIndexes: () => Promise<number>;
  invalidateCatalog: () => Promise<void>;
}

const REPAIR_STEPS = 6;

/**
 * Detect and repair namespace contamination in a datastore.
 *
 * Without `confirm`, yields a preview of what would be cleaned up.
 * With `confirm`, executes the 7-step repair sequence:
 *   1. Delete foreign objects from the remote
 *   2. Rebuild the namespace index (handled by step 1's implementation)
 *   3. Wipe the local cache
 *   4. Re-pull with namespace scoping
 *   5. Invalidate workflow run indexes
 *   6. Invalidate the data catalog
 */
export async function* repairDatastoreContamination(
  _ctx: LibSwampContext,
  deps: RepairDatastoresDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairDatastoresEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const config = await deps.getDatastoreConfig();
      if (!config.namespace) {
        yield { kind: "not_needed" };
        return;
      }

      const detection = await deps.detectContamination();
      if (detection.totalForeignObjects === 0) {
        yield { kind: "not_needed" };
        return;
      }

      const contamination: NamespaceContaminationFinding = {
        foreignNamespaces: detection.foreignNamespaces,
        totalForeignObjects: detection.totalForeignObjects,
      };

      if (!options.confirm) {
        yield {
          kind: "preview",
          contamination,
          namespace: config.namespace,
        };
        return;
      }

      // Step 1: Delete foreign objects + rebuild remote index
      yield {
        kind: "step",
        step: 1,
        total: REPAIR_STEPS,
        description:
          `Deleting ${detection.totalForeignObjects} foreign objects and rebuilding namespace index`,
      };
      const result = await deps.deleteContamination();

      // Step 2: Wipe local cache
      yield {
        kind: "step",
        step: 2,
        total: REPAIR_STEPS,
        description: "Wiping local cache",
      };
      await deps.wipeLocalCache();

      // Step 3: Re-pull scoped
      yield {
        kind: "step",
        step: 3,
        total: REPAIR_STEPS,
        description: `Re-pulling data (scoped to ${config.namespace}/)`,
      };
      const filesPulled = await deps.pullScoped();

      // Step 4: Invalidate workflow run indexes
      yield {
        kind: "step",
        step: 4,
        total: REPAIR_STEPS,
        description: "Invalidating workflow run indexes",
      };
      const indexesInvalidated = await deps.invalidateWorkflowRunIndexes();

      // Step 5: Invalidate data catalog
      yield {
        kind: "step",
        step: 5,
        total: REPAIR_STEPS,
        description: "Invalidating data catalog",
      };
      await deps.invalidateCatalog();

      // Step 6: Report
      yield {
        kind: "step",
        step: 6,
        total: REPAIR_STEPS,
        description: "Verifying repair",
      };

      yield {
        kind: "completed",
        result: {
          foreignNamespaces: result.foreignNamespaces,
          deletedObjects: result.deleted,
          filesPulled,
          workflowRunIndexesInvalidated: indexesInvalidated,
          catalogInvalidated: true,
        },
        namespace: config.namespace,
      };
    })(),
  );
}
