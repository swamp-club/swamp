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
  type CustomDatastoreConfig,
  type DatastoreConfig,
  DEFAULT_DATASTORE_SUBDIRS,
  getDatastoreDirectories,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import {
  type NamespaceContaminationSummary,
  UNPUSHED_REPAIR_EXTENSIONS,
  UNPUSHED_REPAIR_MIN_EXTENSION_VERSION,
  type UnpushedFilesSummary,
} from "../../domain/datastore/datastore_sync_service.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInMessage,
} from "../../domain/control_characters.ts";

import {
  isReservedNamespaceName,
  namespaceCollidesWithLayout,
  reservedV3NamespaceMessage,
} from "../../domain/data/namespace.ts";
import type { LibSwampContext } from "../context.ts";
import { layoutCollisionMessage } from "./namespace_migrate.ts";
import type { SwampError } from "../errors.ts";
import { UserError } from "../../domain/errors.ts";

import { join } from "@std/path";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  retentionCheckFailed,
  type RetentionCheckSummary,
} from "./retention_check.ts";
import type { UnreadableDataVersion } from "../../domain/data/unreadable_data_version.ts";

export interface DatastoreHealthFinding {
  check: string;
  passed: boolean;
  message: string;
}

export interface VaultMismatchFinding {
  vaultName: string;
  vaultType: string;
}

export interface CatalogShortfall {
  typeNormalized: string;
  diskRecords: number;
  catalogRecords: number;
}

/**
 * the catalog is a local index of data on disk; when the walk sees records the
 * index lacks, queries silently under-report
 */
export interface CatalogCompletenessSummary {
  diskRecords: number;
  catalogRecords: number;
  shortfalls: ReadonlyArray<CatalogShortfall>;
}

export const UNREADABLE_VERSIONS_LISTED = 20;

export interface UnreadableVersionsSummary {
  unreadableVersions: number;
  records: number;
  darkRecords: number;
  findings: ReadonlyArray<UnreadableDataVersion>;
}

export function summarizeUnreadableVersions(
  findings: ReadonlyArray<UnreadableDataVersion>,
): UnreadableVersionsSummary {
  const records = new Set<string>();
  const dark = new Set<string>();
  for (const finding of findings) {
    const key = recordKeyOf(finding);
    records.add(key);
    if (finding.latest) dark.add(key);
  }
  return {
    unreadableVersions: findings.length,
    records: records.size,
    darkRecords: dark.size,
    findings: findings.slice(0, UNREADABLE_VERSIONS_LISTED),
  };
}

export function unreadableVersionsFindingMessage(
  summary: UnreadableVersionsSummary,
): string {
  if (summary.unreadableVersions === 0) {
    return "Every published data version is readable";
  }
  const darkNames = [
    ...new Set(
      summary.findings.filter((f) => f.latest).map((f) =>
        `${f.modelName || f.modelId}/${f.dataName}`
      ),
    ),
  ];
  const dark = summary.darkRecords > 0
    ? ` ${summary.darkRecords} of them read as empty or not found, because their latest version is unreadable (${
      firstOf(darkNames, summary.darkRecords)
    }).`
    : "";
  return `${summary.unreadableVersions} published data version(s) in ` +
    `${summary.records} record(s) cannot be read: their files are missing, ` +
    `empty or short, as an unclean shutdown leaves them.${dark} ` +
    `Run 'swamp doctor datastores --repair' to preview rolling each record ` +
    `back to its last readable version.`;
}

function recordKeyOf(
  finding: Pick<UnreadableDataVersion, "modelType" | "modelId" | "dataName">,
): string {
  return `${finding.modelType}\0${finding.modelId}\0${finding.dataName}`;
}

export interface NamespaceContaminationFinding {
  foreignNamespaces: ReadonlyArray<{ namespace: string; objectCount: number }>;
  totalForeignObjects: number;
}

export interface UnpushedFilesFinding {
  unpushed: number;
  samplePaths: readonly string[];
  error?: string;
}

export interface V3ContentSummary {
  unreadableRecords: number;
  unreadable: ReadonlyArray<{
    namespace: string;
    recordKey: string;
    reason: "missing" | "damaged";
    chunk?: string;
    advice: string;
  }>;
  atRiskCopies: number;
  atRisk: ReadonlyArray<{
    namespace: string;
    sha256: string;
    recordKey: string;
    size: number;
  }>;
  atRiskDir: string;
  atRiskAdvice: string;
  tornChunks: number;
  torn: ReadonlyArray<{
    namespace: string;
    sha256: string;
    recordKey: string;
    expectedSize: number;
    size: number;
    advice: string;
  }>;
}

export interface V3KeptLineageFinding {
  fence: number;
  replicaRoot: string;
  holder: string;
  startedAt: string;
}

export const KEPT_LINEAGES_RECOVERY_DOC =
  'design/enablers/datastore-litestream.md, "Recovering kept replication lineages"';

export function keptLineagesFindingMessage(
  kept: ReadonlyArray<V3KeptLineageFinding>,
): string {
  if (kept.length === 0) {
    return "No replication lineages are kept for recovery";
  }
  const listed = kept.map((lineage) =>
    `${
      String(lineage.fence).padStart(12, "0")
    } (root ${lineage.replicaRoot}, ` +
    `started by ${lineage.holder} at ${lineage.startedAt})`
  ).join("; ");
  return `${kept.length} replication lineage(s) are kept because they may ` +
    `hold commits the current lineage lacks: ${listed}. They were written ` +
    `under another spelling of the datastore's S3 endpoint by a swamp ` +
    `before swamp-club#3801 that did not see the others. Chunk collection ` +
    `is deferred while they exist, so the bucket's storage is not ` +
    `reclaimed. Recover any commits you need from them, then remove them ` +
    `as ${KEPT_LINEAGES_RECOVERY_DOC} describes.`;
}

export interface V3ReplicaRestorableFinding {
  status: "verified" | "unverified" | "broken" | "broken-copy-damaged";
  lineageFence?: number;
  txid?: string;
  checkedAt?: string;
  error?: string;
  copyCheck?: string;
}

export function replicaRestorablePassed(
  finding: V3ReplicaRestorableFinding,
): boolean {
  return finding.status === "verified" || finding.status === "unverified";
}

export function replicaRestorableFindingMessage(
  finding: V3ReplicaRestorableFinding,
): string {
  const error = finding.error ?? "its restore failed SQLite's integrity check";
  const lineage = finding.lineageFence === undefined
    ? "this checkout's replication lineage"
    : `replication lineage ${String(finding.lineageFence).padStart(12, "0")}`;
  switch (finding.status) {
    case "verified":
      return `The replica of ${lineage} restored cleanly at TXID ` +
        `${finding.txid} (checked ${finding.checkedAt})`;
    case "unverified":
      return `The replica of ${lineage} has not been checked yet; this ` +
        `checkout's Litestream sidecar checks it after it replicates`;
    case "broken":
      return `The replica of ${lineage} cannot be restored: ${error}. ` +
        `Other checkouts cannot clone or refresh from it. This checkout's ` +
        `copy is intact, so the next write command, or a running swamp ` +
        `serve, starts a new lineage from it`;
    case "broken-copy-damaged":
      return `The replica of ${lineage} cannot be restored: ${error}. ` +
        `This checkout's own copy fails SQLite's quick check too ` +
        `(${finding.copyCheck}), so no new lineage is started from it. ` +
        `Restore this checkout from an older lineage or a backup, as ` +
        `${KEPT_LINEAGES_RECOVERY_DOC} describes`;
  }
}

export interface DoctorDatastoresData {
  datastoreType: string;
  isCustom: boolean;
  healthFindings: DatastoreHealthFinding[];
  vaultMismatchFindings: VaultMismatchFinding[];
  contaminationFinding?: NamespaceContaminationFinding;
  unpushedFilesFinding?: UnpushedFilesFinding;
  catalogCompletenessFinding?: CatalogCompletenessSummary;
  unreadableVersionsFinding?: UnreadableVersionsSummary;
  retentionFinding?: RetentionCheckSummary;
  v3ContentFinding?: V3ContentSummary;
  v3KeptLineagesFinding?: V3KeptLineageFinding[];
  v3ReplicaRestorableFinding?: V3ReplicaRestorableFinding;
}

export interface DoctorDatastoresOptions {
  retention?: boolean;
}

export type DoctorDatastoresEvent =
  | { kind: "scanning" }
  | { kind: "completed"; data: DoctorDatastoresData }
  | { kind: "error"; error: SwampError };

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
  checkUnpushedFiles?: (
    config: DatastoreConfig,
  ) => Promise<UnpushedFilesSummary | null>;
  /**
   * must read the catalog directly and never issue a data query: querying
   * triggers backfill, and a diagnostic that repairs what it measures always
   * reports health
   */
  checkCatalogCompleteness?: () => Promise<CatalogCompletenessSummary | null>;
  /**
   * given only on a format 2 filesystem datastore, whose files are all local (a
   * v3 checkout is covered by checkV3Content). Read-only; like
   * checkCatalogCompleteness it never issues a data query.
   */
  checkUnreadableVersions?: () => Promise<UnreadableDataVersion[]>;
  checkRetention?: () => Promise<RetentionCheckSummary>;
  checkV3Content?: (config: DatastoreConfig) => Promise<V3ContentSummary>;
  checkV3Filter?: (config: DatastoreConfig) => Promise<string | undefined>;
  checkV3KeptLineages?: (
    config: DatastoreConfig,
  ) => Promise<V3KeptLineageFinding[]>;
  checkV3ReplicaRestorable?: (
    config: DatastoreConfig,
  ) => Promise<V3ReplicaRestorableFinding | undefined>;
}

export function v3ContentPassed(summary: V3ContentSummary): boolean {
  return summary.unreadableRecords === 0 && summary.atRiskCopies === 0 &&
    summary.tornChunks === 0;
}

export function v3ContentFindingMessage(summary: V3ContentSummary): string {
  if (v3ContentPassed(summary)) {
    return "Every record of this v3 checkout is readable, and no content is held aside";
  }
  const parts: string[] = [];
  if (summary.unreadableRecords > 0) {
    parts.push(
      `${summary.unreadableRecords} record(s) cannot be read: a chunk is missing or damaged in the datastore (${
        firstOf(
          summary.unreadable.map((r) => r.recordKey),
          summary.unreadableRecords,
        )
      })`,
    );
  }
  if (summary.atRiskCopies > 0) {
    parts.push(
      `${summary.atRiskCopies} checkout file(s) were moved aside into ${summary.atRiskDir} because the datastore refused their chunks (${
        firstOf(
          summary.atRisk.map((c) => c.recordKey || c.sha256),
          summary.atRiskCopies,
        )
      })`,
    );
  }
  if (summary.tornChunks > 0) {
    parts.push(
      `${summary.tornChunks} chunk(s) the checkout's records name are stored short (${
        firstOf(summary.torn.map((c) => c.recordKey), summary.tornChunks)
      })`,
    );
  }
  return `${parts.join("; ")}.`;
}

function firstOf(keys: readonly string[], total: number): string {
  const shown = keys.slice(0, 3);
  const more = total - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export function retentionFindingMessage(
  summary: RetentionCheckSummary,
): string {
  if (!summary.configured) {
    return "Retention is not configured (no garbageCollection retention in .swamp.yaml); nothing to check";
  }
  const overdue = summary.kinds.reduce((n, kind) => n + kind.overdue, 0);
  const historyOverdue = summary.v3History?.overdue === true;
  if (overdue === 0 && !historyOverdue) {
    return "No stored item is older than its retention";
  }
  const parts: string[] = [];
  if (overdue > 0) {
    parts.push(`${overdue} item(s) are older than their retention`);
  }
  if (historyOverdue) {
    parts.push(
      `v3 commit history reaches back to ${
        summary.v3History!.oldestCommitAt
      }, past ${summary.v3History!.failBefore}`,
    );
  }
  return `${parts.join("; ")}. ` +
    (summary.automatic
      ? "Automatic retention has not removed them yet: check that a retention pass runs (serve, or a CLI command that writes)."
      : "Retention is not automatic: set garbageCollection.automatic: true, or run 'swamp run gc' and 'swamp data gc' (audit logs are pruned only automatically).");
}

export async function* doctorDatastores(
  _ctx: LibSwampContext,
  deps: DoctorDatastoresDeps,
  options: DoctorDatastoresOptions = {},
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
      let unpushedFilesFinding: UnpushedFilesFinding | undefined;
      let catalogCompletenessFinding: CatalogCompletenessSummary | undefined;
      let unreadableVersionsFinding: UnreadableVersionsSummary | undefined;
      let retentionFinding: RetentionCheckSummary | undefined;
      let v3ContentFinding: V3ContentSummary | undefined;
      let v3KeptLineagesFinding: V3KeptLineageFinding[] | undefined;
      let v3ReplicaRestorableFinding: V3ReplicaRestorableFinding | undefined;

      const { healthy, message } = await deps.checkHealth(config);
      healthFindings.push({
        check: "health",
        passed: healthy,
        message,
      });

      // a namespace named after a layout directory shares it with the solo
      // layout, so the un-migrated data check is skipped; on v3 all reserved
      // names collide, the checkout materialising it at .swamp/<name>
      const namespaceCollides = config.namespace !== undefined &&
        (namespaceCollidesWithLayout(
          config.namespace,
          getDatastoreDirectories(config),
        ) ||
          (config.format === 3 && isReservedNamespaceName(config.namespace)));
      if (config.namespace && namespaceCollides) {
        healthFindings.push({
          check: "reserved_namespace",
          passed: false,
          // a v3 checkout refuses to open on a reserved name, and the v2 steps
          // to move off it are refused on v3
          message: config.format === 3 &&
              isReservedNamespaceName(config.namespace)
            ? reservedV3NamespaceMessage(config.namespace)
            : layoutCollisionMessage(config.namespace),
        });
      }

      if (
        config.namespace && !namespaceCollides && deps.checkUnmigratedData
      ) {
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

      // a scan that fails fails this check on its own while the others still
      // report; it runs before the completeness walk so the versions it reports
      // are not warned about again
      if (deps.checkUnreadableVersions) {
        let summary: UnreadableVersionsSummary | undefined;
        let failure: string | undefined;
        try {
          summary = summarizeUnreadableVersions(
            await deps.checkUnreadableVersions(),
          );
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (summary !== undefined && summary.unreadableVersions > 0) {
          unreadableVersionsFinding = summary;
        }
        healthFindings.push({
          check: "unreadable_versions",
          passed: summary !== undefined && summary.unreadableVersions === 0,
          message: summary === undefined
            ? `Could not check whether every published data version is readable: ${failure}`
            : unreadableVersionsFindingMessage(summary),
        });
      }

      // advisory: a failure is reported in the finding and the scan goes on
      if (isCustom && deps.checkUnpushedFiles) {
        try {
          const summary = await deps.checkUnpushedFiles(config);
          if (summary && summary.unpushed > 0) {
            unpushedFilesFinding = {
              unpushed: summary.unpushed,
              samplePaths: summary.samplePaths,
            };
          }
        } catch (error) {
          unpushedFilesFinding = {
            unpushed: 0,
            samplePaths: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      // Catalog completeness check — the catalog is a local index, so this
      // runs for every repo, with or without a namespace or remote datastore.
      if (deps.checkCatalogCompleteness) {
        const isLazy = isCustom &&
          (config as CustomDatastoreConfig).hydrationStrategy === "lazy";
        const summary = await deps.checkCatalogCompleteness();
        if (summary && summary.shortfalls.length > 0) {
          catalogCompletenessFinding = summary;
          const missing = summary.diskRecords - summary.catalogRecords;
          healthFindings.push({
            check: "catalog_completeness",
            passed: false,
            message:
              `Catalog index is missing ${missing} record(s) across ${summary.shortfalls.length} model type(s) ` +
              `that exist on disk. Queries against them return nothing. ` +
              `Run 'swamp doctor datastores --repair' to preview a rebuild.`,
          });
        } else if (summary) {
          const qualifier = isLazy
            ? " on disk (lazy hydration: only locally materialized data is checked)"
            : " on disk";
          healthFindings.push({
            check: "catalog_completeness",
            passed: true,
            message:
              `Catalog index covers all ${summary.diskRecords} record(s)${qualifier}`,
          });
        }
      }

      // a v3 checkout whose directories changed refuses to open: reported here,
      // and the checks below that open it are skipped
      let v3FilterRefused = false;
      if (deps.checkV3Filter) {
        // A state it cannot read (a read-only state directory) fails this
        // check on its own, as the v3 content check below does.
        let refusal: string | undefined;
        let failure: string | undefined;
        try {
          refusal = await deps.checkV3Filter(config);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        v3FilterRefused = refusal !== undefined;
        healthFindings.push({
          check: "v3_directories",
          passed: refusal === undefined && failure === undefined,
          message: failure !== undefined
            ? `Could not read this v3 checkout's directories: ${failure}`
            : refusal ??
              "This v3 checkout was built with the directories the repo's datastore config gives",
        });
      }

      // Retention check — only on request: it reads every stored record.
      if (options.retention && deps.checkRetention && v3FilterRefused) {
        healthFindings.push({
          check: "retention",
          passed: false,
          message:
            "Skipped: this v3 checkout does not open until its directories are restored (see v3_directories)",
        });
      } else if (options.retention && deps.checkRetention) {
        // the scan opens the repository, which a checkout swamp refuses to open
        // (a v3 one on a reserved namespace) cannot: that refusal is this
        // check's finding, and the others still report
        let refusal: string | undefined;
        try {
          retentionFinding = await deps.checkRetention();
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          refusal = error.message;
        }
        healthFindings.push(
          retentionFinding === undefined
            ? {
              check: "retention",
              passed: false,
              message: `Could not run the retention check: ${refusal}`,
            }
            : {
              check: "retention",
              passed: !retentionCheckFailed(retentionFinding),
              message: retentionFindingMessage(retentionFinding),
            },
        );
      }

      // checkout-local state only. A check that cannot read the state (a
      // read-only directory, where SQLite cannot create the WAL shared-memory
      // file) fails on its own; the other checks still report.
      if (deps.checkV3Content) {
        let summary: V3ContentSummary | undefined;
        let failure: string | undefined;
        try {
          summary = await deps.checkV3Content(config);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (summary === undefined) {
          healthFindings.push({
            check: "v3_content",
            passed: false,
            message: `Could not inspect this v3 checkout's content: ${failure}`,
          });
        } else {
          const passed = v3ContentPassed(summary);
          if (!passed) v3ContentFinding = summary;
          healthFindings.push({
            check: "v3_content",
            passed,
            message: v3ContentFindingMessage(summary),
          });
        }
      }

      // reported on every run, since chunk collection waits on kept lineages
      // until an operator acts
      if (deps.checkV3KeptLineages && !v3FilterRefused) {
        let kept: V3KeptLineageFinding[] | undefined;
        let failure: string | undefined;
        try {
          kept = await deps.checkV3KeptLineages(config);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (kept !== undefined && kept.length > 0) {
          v3KeptLineagesFinding = kept;
        }
        healthFindings.push({
          check: "v3_kept_lineages",
          passed: kept !== undefined && kept.length === 0,
          message: kept === undefined
            ? `Could not read this v3 datastore's replication lineages: ${failure}`
            : keptLineagesFindingMessage(kept),
        });
      }

      if (deps.checkV3ReplicaRestorable && !v3FilterRefused) {
        let finding: V3ReplicaRestorableFinding | undefined;
        let failure: string | undefined;
        try {
          finding = await deps.checkV3ReplicaRestorable(config);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (failure !== undefined) {
          healthFindings.push({
            check: "v3_replica_restorable",
            passed: false,
            message:
              `Could not read whether this checkout's replica can be restored: ${failure}`,
          });
        } else if (finding !== undefined) {
          const passed = replicaRestorablePassed(finding);
          if (!passed) v3ReplicaRestorableFinding = finding;
          healthFindings.push({
            check: "v3_replica_restorable",
            passed,
            message: replicaRestorableFindingMessage(finding),
          });
        }
      }

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
          ...(unpushedFilesFinding ? { unpushedFilesFinding } : {}),
          catalogCompletenessFinding,
          ...(unreadableVersionsFinding ? { unreadableVersionsFinding } : {}),
          ...(retentionFinding ? { retentionFinding } : {}),
          ...(v3ContentFinding ? { v3ContentFinding } : {}),
          ...(v3KeptLineagesFinding ? { v3KeptLineagesFinding } : {}),
          ...(v3ReplicaRestorableFinding ? { v3ReplicaRestorableFinding } : {}),
        },
      };
    })(),
  );
}

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

export interface RepairDatastoresDeps {
  getDatastoreConfig: () => Promise<DatastoreConfig>;
  detectContamination: () => Promise<NamespaceContaminationSummary>;
  deleteContamination: () => Promise<NamespaceContaminationSummary>;
  wipeLocalCache: () => Promise<void>;
  pullScoped: () => Promise<number>;
  invalidateWorkflowRunIndexes: () => Promise<number>;
  invalidateCatalog: () => Promise<void>;
  /**
   * why wiping the local cache would lose data or pending work, or undefined
   * when it is safe; checked after the preview, before anything changes
   */
  checkCacheSafeToWipe?: () => Promise<string | undefined>;
}

const REPAIR_STEPS = 5;

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

      let refusal: string | undefined;
      try {
        refusal = await deps.checkCacheSafeToWipe?.();
      } catch (err) {
        refusal =
          `Refusing to wipe the local cache: could not check what it holds: ${
            errorText(err).trimEnd()
          }`;
      }
      if (refusal !== undefined) {
        yield {
          kind: "error",
          error: {
            code: "repair_refused",
            message: `${
              refusal.includes("\n") ? `${refusal}\n` : `${refusal} `
            }The cache was not wiped and no foreign objects were deleted.`,
          },
        };
        return;
      }

      let lastCompletedStep = 0;
      try {
        yield {
          kind: "step",
          step: 1,
          total: REPAIR_STEPS,
          description:
            `Deleting ${detection.totalForeignObjects} foreign objects and rebuilding namespace index`,
        };
        const result = await deps.deleteContamination();
        lastCompletedStep = 1;

        yield {
          kind: "step",
          step: 2,
          total: REPAIR_STEPS,
          description: "Wiping local cache",
        };
        await deps.wipeLocalCache();
        lastCompletedStep = 2;

        yield {
          kind: "step",
          step: 3,
          total: REPAIR_STEPS,
          description: `Re-pulling data (scoped to ${config.namespace}/)`,
        };
        const filesPulled = await deps.pullScoped();
        lastCompletedStep = 3;

        yield {
          kind: "step",
          step: 4,
          total: REPAIR_STEPS,
          description: "Invalidating workflow run indexes",
        };
        const indexesInvalidated = await deps.invalidateWorkflowRunIndexes();
        lastCompletedStep = 4;

        yield {
          kind: "step",
          step: 5,
          total: REPAIR_STEPS,
          description: "Invalidating data catalog",
        };
        await deps.invalidateCatalog();
        lastCompletedStep = 5;

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
      } catch (err) {
        // Once the foreign objects are gone a re-run finds nothing to repair,
        // so it would never reach the invalidation steps. A wipe that failed
        // partway may have removed files they describe. Each is tried here on
        // its own.
        const invalidations: Array<[string, () => Promise<unknown>]> = [];
        if (lastCompletedStep === 1 || lastCompletedStep === 2) {
          invalidations.push([
            "workflow run indexes",
            deps.invalidateWorkflowRunIndexes,
          ]);
        }
        if (lastCompletedStep >= 1 && lastCompletedStep <= 3) {
          invalidations.push(["data catalog", deps.invalidateCatalog]);
        }
        let invalidationFailure = "";
        for (const [what, invalidate] of invalidations) {
          try {
            await invalidate();
          } catch (invalidateErr) {
            invalidationFailure += ` Invalidating the ${what} failed too: ${
              errorText(invalidateErr).trimEnd()
            }`;
          }
        }
        yield {
          kind: "error",
          error: {
            code: "repair_failed",
            message:
              `Repair failed at step ${
                lastCompletedStep + 1
              }/${REPAIR_STEPS}: ${errorText(err)}` +
              (lastCompletedStep >= 2
                ? `Local cache was wiped — run 'swamp datastore sync --pull' to restore.${invalidationFailure}`
                : lastCompletedStep >= 1
                ? `Foreign objects were deleted but local cache was not refreshed — run 'swamp datastore sync --pull' to restore.${invalidationFailure}`
                : `Some foreign objects may already be deleted, and the local cache was not touched. Run 'swamp doctor datastores --repair -y' again; if it finds nothing to repair, run 'swamp datastore sync --pull'.`),
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

export type RepairUnpushedFilesEvent =
  | { kind: "scanning" }
  | { kind: "preview"; summary: UnpushedFilesSummary }
  | { kind: "step"; description: string }
  | { kind: "completed"; summary: UnpushedFilesSummary }
  | { kind: "not_needed" }
  | { kind: "not_supported"; message: string }
  | { kind: "error"; error: SwampError };

export interface RepairUnpushedFilesDeps {
  unsupported?: string;
  detect: () => Promise<UnpushedFilesSummary>;
  repair: () => Promise<UnpushedFilesSummary>;
}

/**
 * a batch failure names files and a file name can hold an escape sequence; a
 * multi-line message ends its last line so what follows starts a new one
 */
function errorText(err: unknown): string {
  const text = escapeControlCharactersInMessage(
    err instanceof Error ? err.message : String(err),
  ).trimEnd();
  return text.includes("\n") ? `${text}\n` : `${text.replace(/\.+$/, "")}. `;
}

export function unpushedRepairUnsupportedMessage(
  datastoreType: string,
  extension: string,
): string {
  return UNPUSHED_REPAIR_EXTENSIONS.includes(datastoreType)
    ? `The ${datastoreType} datastore extension cannot find cache files the remote never received: that needs ${UNPUSHED_REPAIR_MIN_EXTENSION_VERSION} or later. Run \`swamp extension update ${extension}\` to update it.`
    : `The ${datastoreType} datastore extension does not implement repairUnpushedFiles, so it cannot find cache files the remote never received. Ask its author to add it.`;
}

export function unpushedFilesClear(summary: UnpushedFilesSummary): boolean {
  return summary.unpushed === 0 && summary.alreadyPresent === 0 &&
    summary.locallyModified === 0 && summary.unknown === 0 &&
    summary.peerDeleted === 0;
}

/**
 * a copy the remote moved on from is stale, and a copy a peer deleted does not
 * block: older releases left many, so the stage's output names them instead
 */
export function cacheWipeRefusal(
  summary: UnpushedFilesSummary,
  cacheDir: string,
): string | undefined {
  const reasons: string[] = [];
  // first, because a push deletes a marked file that is gone from the remote,
  // so removing one as the advice says would delete it for everyone
  if (summary.pendingChanges) {
    reasons.push(
      "changes recorded locally that no push has sent; run 'swamp datastore sync --push' first, and remove nothing from the cache before it: that push deletes from the remote, for everyone, a changed file that is gone",
    );
  }
  if (summary.unpushed > 0) {
    reasons.push(
      `${summary.unpushed} cache file(s) the remote never received (${
        firstOf(
          summary.samplePaths.map(escapeControlCharacters),
          summary.unpushed,
        )
      }); run the repair again to upload them`,
    );
  }
  const localOnly = summary.alreadyPresent + summary.locallyModified +
    summary.unknown;
  if (localOnly > 0) {
    const samples = [
      ...summary.sampleAlreadyPresent,
      ...summary.sampleModified,
      ...summary.sampleUnknown,
    ];
    reasons.push(
      `${localOnly} local version(s) the remote does not hold (${
        firstOf(samples.map(escapeControlCharacters), localOnly)
      }); copy any you want to keep out of ${cacheDir}, remove them there, and run this again. Do not pull first: a pull overwrites them`,
    );
  }
  return reasons.length === 0
    ? undefined
    : `Refusing to wipe the local cache: ${reasons.join("; ")}.`;
}

/**
 * uploads through the datastore's repairUnpushedFiles, which deletes nothing
 * and leaves pending pushes alone; local versions the remote lacks are
 * reported, never uploaded
 */
export async function* repairUnpushedCacheFiles(
  _ctx: LibSwampContext,
  deps: RepairUnpushedFilesDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairUnpushedFilesEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair_unpushed",
    {},
    (async function* () {
      yield { kind: "scanning" };
      if (deps.unsupported !== undefined) {
        yield {
          kind: "not_supported",
          message:
            `${deps.unsupported} Until then, namespace contamination repair refuses to wipe the cache.`,
        };
        return;
      }
      try {
        if (!options.confirm) {
          const summary = await deps.detect();
          if (unpushedFilesClear(summary)) {
            yield { kind: "not_needed" };
          } else {
            yield { kind: "preview", summary };
          }
          return;
        }
        yield {
          kind: "step",
          description: "Uploading cache files the remote never received",
        };
        const summary = await deps.repair();
        if (summary.uploaded === 0 && unpushedFilesClear(summary)) {
          yield { kind: "not_needed" };
        } else {
          yield { kind: "completed", summary };
        }
      } catch (err) {
        yield {
          kind: "error",
          error: {
            code: "repair_failed",
            message: options.confirm
              ? `Repairing unpushed cache files failed: ${
                errorText(err)
              }Files uploaded before the failure stay uploaded and nothing was deleted. Once the cause is fixed, running the repair again continues from there.`
              : `Checking for unpushed cache files failed: ${
                errorText(err)
              }Nothing was uploaded or deleted.`,
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

export interface UnmigratedDataRepairResult {
  removedDirectories: string[];
  removedFiles: number;
}

export type RepairUnmigratedDataEvent =
  | { kind: "scanning" }
  | {
    kind: "preview";
    directories: string[];
    namespace: string;
  }
  | { kind: "step"; description: string }
  | {
    kind: "completed";
    result: UnmigratedDataRepairResult;
    namespace: string;
  }
  | { kind: "not_needed" }
  | { kind: "error"; error: SwampError };

export interface RepairUnmigratedDataDeps {
  getBasePath: () => string;
  getNamespace: () => string;
  getDatastoreDirectories: () => readonly string[];
  listFiles: (dir: string) => Promise<string[]>;
  compareFiles: (a: string, b: string) => Promise<boolean>;
  removeFile: (path: string) => Promise<void>;
  removeEmptyDirs: (dir: string) => Promise<void>;
  dirExists: (path: string) => Promise<boolean>;
}

export async function* repairUnmigratedData(
  _ctx: LibSwampContext,
  deps: RepairUnmigratedDataDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairUnmigratedDataEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair.unmigrated",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const basePath = deps.getBasePath();
      const namespace = deps.getNamespace();

      if (
        namespaceCollidesWithLayout(namespace, deps.getDatastoreDirectories())
      ) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: layoutCollisionMessage(namespace),
          },
        };
        return;
      }

      const unmigratedDirs: string[] = [];
      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        const rootDir = join(basePath, subdir);
        if (await deps.dirExists(rootDir)) {
          const files = await deps.listFiles(rootDir);
          if (files.length > 0) {
            unmigratedDirs.push(subdir);
          }
        }
      }

      if (unmigratedDirs.length === 0) {
        yield { kind: "not_needed" };
        return;
      }

      if (!options.confirm) {
        yield { kind: "preview", directories: unmigratedDirs, namespace };
        return;
      }

      let totalRemoved = 0;
      const cleaned: string[] = [];

      for (const subdir of unmigratedDirs) {
        yield {
          kind: "step",
          description:
            `Checking ${subdir}/ for duplicates against ${namespace}/${subdir}/`,
        };

        const rootDir = join(basePath, subdir);
        const nsDir = join(basePath, namespace, subdir);
        const files = await deps.listFiles(rootDir);

        let allIdentical = true;
        for (const relPath of files) {
          const rootFile = join(rootDir, relPath);
          const nsFile = join(nsDir, relPath);
          if (!await deps.compareFiles(rootFile, nsFile)) {
            allIdentical = false;
            break;
          }
        }

        if (!allIdentical) {
          yield {
            kind: "error",
            error: {
              code: "non_identical_unmigrated_data",
              message:
                `Root-level "${subdir}/" contains files that differ from ` +
                `"${namespace}/${subdir}/". Run 'swamp datastore namespace migrate --confirm' ` +
                `to resolve manually.`,
            },
          };
          return;
        }

        for (const relPath of files) {
          await deps.removeFile(join(rootDir, relPath));
          totalRemoved++;
        }
        await deps.removeEmptyDirs(rootDir);
        cleaned.push(subdir);
      }

      yield {
        kind: "completed",
        result: {
          removedDirectories: cleaned,
          removedFiles: totalRemoved,
        },
        namespace,
      };
    })(),
  );
}

export interface UnreadableRecordRepair {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  removeVersions: number[];
  markerUnreadable: boolean;
  becomesLatest: number | null;
  /**
   * false when no readable version is left but a crashed, never-published write
   * remains; the record then reads as absent
   */
  removed?: boolean;
}

export interface UnreadableVersionsRepairResult {
  records: UnreadableRecordRepair[];
  versionsRemoved: number;
  recordsRemoved: number;
  versionsKept: number;
}

export type RepairUnreadableVersionsEvent =
  | { kind: "scanning" }
  | { kind: "preview"; records: UnreadableRecordRepair[] }
  | { kind: "step"; description: string }
  | { kind: "completed"; result: UnreadableVersionsRepairResult }
  | { kind: "not_needed" }
  | { kind: "error"; error: SwampError };

export interface UnreadableRecordKey {
  modelType: string;
  modelId: string;
  dataName: string;
}

export interface UnreadableVersionsRepairOps {
  scan: () => Promise<UnreadableDataVersion[]>;
  /**
   * keeps the catalog from gaining a row for a crashed write that was never
   * published; with no versions it only resets the latest marker
   */
  rollBack: (
    record: UnreadableRecordKey,
    versions: readonly number[],
  ) => Promise<{ latest: number | null; removed: boolean }>;
}

export interface RepairUnreadableVersionsDeps {
  scan: () => Promise<UnreadableDataVersion[]>;
  /**
   * releases the locks in a finally, so a failed repair never leaves a model
   * locked against a running serve
   */
  underModelLocks: <T>(
    models: ReadonlyArray<{ modelType: string; modelId: string }>,
    fn: (ops: UnreadableVersionsRepairOps) => Promise<T>,
  ) => Promise<T>;
}

export function planUnreadableVersionRepairs(
  findings: ReadonlyArray<UnreadableDataVersion>,
): UnreadableRecordRepair[] {
  const records = new Map<string, UnreadableRecordRepair>();
  for (const finding of findings) {
    const key = recordKeyOf(finding);
    let record = records.get(key);
    if (record === undefined) {
      record = {
        modelType: finding.modelType,
        modelId: finding.modelId,
        modelName: finding.modelName,
        dataName: finding.dataName,
        removeVersions: [],
        markerUnreadable: false,
        becomesLatest: finding.readableVersion,
      };
      records.set(key, record);
    }
    if (finding.version === null) record.markerUnreadable = true;
    else record.removeVersions.push(finding.version);
  }
  for (const record of records.values()) {
    record.removeVersions.sort((a, b) => b - a);
  }
  return [...records.values()];
}

export async function* repairUnreadableVersions(
  _ctx: LibSwampContext,
  deps: RepairUnreadableVersionsDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairUnreadableVersionsEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair.unreadable_versions",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const planned = planUnreadableVersionRepairs(await deps.scan());
      if (planned.length === 0) {
        yield { kind: "not_needed" };
        return;
      }
      if (!options.confirm) {
        yield { kind: "preview", records: planned };
        return;
      }

      const plannedVersions = planned.reduce(
        (n, record) => n + record.removeVersions.length,
        0,
      );
      yield {
        kind: "step",
        description:
          `Rolling ${planned.length} record(s) back to their last readable version`,
      };
      const models = [
        ...new Map(
          planned.map((record) => [
            `${record.modelType}\0${record.modelId}`,
            { modelType: record.modelType, modelId: record.modelId },
          ]),
        ).values(),
      ];
      let versionsRemoved = 0;
      try {
        const result = await deps.underModelLocks(models, async (ops) => {
          // Under the locks no write is in flight: what is unreadable now
          // stays so until the repair is done.
          const now = new Map(
            planUnreadableVersionRepairs(await ops.scan()).map((record) => [
              recordKeyOf(record),
              record,
            ]),
          );
          const repaired: UnreadableRecordRepair[] = [];
          let recordsRemoved = 0;
          for (const record of planned) {
            const current = now.get(recordKeyOf(record));
            if (current === undefined) continue;
            const listed = new Set(record.removeVersions);
            const removeVersions = current.removeVersions.filter((v) =>
              listed.has(v)
            );
            const markerUnreadable = record.markerUnreadable &&
              current.markerUnreadable;
            if (removeVersions.length === 0 && !markerUnreadable) continue;
            const { latest: becomesLatest, removed } = await ops.rollBack(
              record,
              removeVersions,
            );
            versionsRemoved += removeVersions.length;
            if (removed) recordsRemoved++;
            repaired.push({
              ...current,
              removeVersions,
              markerUnreadable,
              becomesLatest,
              removed,
            });
          }
          return { repaired, recordsRemoved };
        });
        yield {
          kind: "completed",
          result: {
            records: result.repaired,
            versionsRemoved,
            recordsRemoved: result.recordsRemoved,
            versionsKept: plannedVersions - versionsRemoved,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          kind: "error",
          error: {
            code: "unreadable_versions_repair_failed",
            message: `Could not roll back the unreadable data versions: ` +
              `${message}. ${versionsRemoved} unreadable version(s) were ` +
              `removed before the failure. Run 'swamp doctor datastores ` +
              `--repair' again to preview what is left.`,
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

export interface CatalogIndexRepairResult {
  shortfalls: ReadonlyArray<CatalogShortfall>;
  missingRecords: number;
}

export type RepairCatalogIndexEvent =
  | { kind: "scanning" }
  | { kind: "preview"; completeness: CatalogCompletenessSummary }
  | { kind: "step"; description: string }
  | { kind: "completed"; result: CatalogIndexRepairResult }
  | { kind: "not_needed" }
  | { kind: "error"; error: SwampError };

export interface RepairCatalogIndexDeps {
  checkCompleteness: () => Promise<CatalogCompletenessSummary | null>;
  invalidateCatalog: () => Promise<void>;
}

/**
 * repair deletes the catalog database and the next data query backfills it from
 * disk, so it cannot hide a wrong walk; foreign-namespace rows are dropped and
 * only catalog pull restores them
 */
export async function* repairCatalogIndex(
  _ctx: LibSwampContext,
  deps: RepairCatalogIndexDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairCatalogIndexEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair.catalog",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const completeness = await deps.checkCompleteness();
      if (!completeness || completeness.shortfalls.length === 0) {
        yield { kind: "not_needed" };
        return;
      }

      if (!options.confirm) {
        yield { kind: "preview", completeness };
        return;
      }

      try {
        yield {
          kind: "step",
          description:
            "Removing the catalog index (rebuilds on the next data query)",
        };
        await deps.invalidateCatalog();

        yield {
          kind: "completed",
          result: {
            shortfalls: completeness.shortfalls,
            missingRecords: completeness.diskRecords -
              completeness.catalogRecords,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          kind: "error",
          error: {
            code: "catalog_repair_failed",
            message:
              `Could not remove the catalog index: ${message}. No changes were made.`,
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

export interface CatalogDuplicateLatestResult {
  demotedRows: number;
}

export type RepairCatalogDuplicateLatestEvent =
  | { kind: "scanning" }
  | { kind: "preview"; duplicateCount: number }
  | { kind: "step"; description: string }
  | { kind: "completed"; result: CatalogDuplicateLatestResult }
  | { kind: "not_needed" }
  | { kind: "error"; error: SwampError };

export interface RepairCatalogDuplicateLatestDeps {
  countDuplicateLatest: () => number;
  enforceUniqueLatest: () => number;
}

export async function* repairCatalogDuplicateLatest(
  _ctx: LibSwampContext,
  deps: RepairCatalogDuplicateLatestDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairCatalogDuplicateLatestEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair.duplicate_latest",
    {},
    (async function* () {
      yield { kind: "scanning" };

      const duplicateCount = deps.countDuplicateLatest();
      if (duplicateCount === 0) {
        yield { kind: "not_needed" };
        return;
      }

      if (!options.confirm) {
        yield { kind: "preview", duplicateCount };
        return;
      }

      try {
        yield {
          kind: "step",
          description:
            "Recomputing latest flags so each record has exactly one latest version",
        };
        const demotedRows = deps.enforceUniqueLatest();

        yield {
          kind: "completed",
          result: { demotedRows },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          kind: "error",
          error: {
            code: "duplicate_latest_repair_failed",
            message:
              `Could not repair duplicate is_latest flags: ${message}. No changes were made.`,
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

export type LostFormatMarkerState = "absent" | "blank";

export interface DatastoreFormatMarkerRepairData {
  datastorePath: string;
  markerPath: string;
  marker: LostFormatMarkerState;
}

export type RepairDatastoreFormatMarkerEvent =
  | { kind: "inspecting" }
  | { kind: "preview"; data: DatastoreFormatMarkerRepairData }
  | { kind: "completed"; data: DatastoreFormatMarkerRepairData }
  | { kind: "not_needed"; datastorePath: string }
  | { kind: "error"; error: SwampError };

export interface RepairDatastoreFormatMarkerDeps {
  datastorePath: string;
  markerPath: string;
  /** stats the commit log and never opens it */
  inspect: () => Promise<LostFormatMarkerState | undefined>;
  restore: () => Promise<string>;
}

export async function* repairDatastoreFormatMarker(
  _ctx: LibSwampContext,
  deps: RepairDatastoreFormatMarkerDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairDatastoreFormatMarkerEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair.format_marker",
    {},
    (async function* () {
      yield { kind: "inspecting" };

      const marker = await deps.inspect();
      if (marker === undefined) {
        yield { kind: "not_needed", datastorePath: deps.datastorePath };
        return;
      }
      const data: DatastoreFormatMarkerRepairData = {
        datastorePath: deps.datastorePath,
        markerPath: deps.markerPath,
        marker,
      };
      if (!options.confirm) {
        yield { kind: "preview", data };
        return;
      }

      try {
        const markerPath = await deps.restore();
        yield { kind: "completed", data: { ...data, markerPath } };
      } catch (err) {
        yield {
          kind: "error",
          error: {
            code: err instanceof UserError && err.code
              ? err.code
              : "format_marker_repair_failed",
            message: err instanceof Error ? err.message : String(err),
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

export interface PreV3RecordsRepairData {
  swampDir: string;
  recordDirs: string[];
  destination?: string;
  preV3RecordsDir: string;
}

export type RepairPreV3RecordsEvent =
  | { kind: "inspecting" }
  | { kind: "preview"; data: PreV3RecordsRepairData }
  | { kind: "completed"; data: PreV3RecordsRepairData }
  | { kind: "not_needed"; swampDir: string }
  | { kind: "error"; error: SwampError };

export interface RepairPreV3RecordsDeps {
  swampDir: string;
  preV3RecordsDir: string;
  inspect: () => Promise<string[]>;
  moveAside: () => Promise<{ destination: string; moved: readonly string[] }>;
}

/**
 * a v3 datastore starts empty, so its first open refuses a checkout whose
 * .swamp held records; moving them aside lets the next command catch up from
 * the datastore
 */
export async function* repairPreV3Records(
  _ctx: LibSwampContext,
  deps: RepairPreV3RecordsDeps,
  options: { confirm: boolean },
): AsyncGenerator<RepairPreV3RecordsEvent> {
  yield* withGeneratorSpan(
    "swamp.doctor.datastores.repair.pre_v3_records",
    {},
    (async function* () {
      yield { kind: "inspecting" };

      const recordDirs = await deps.inspect();
      if (recordDirs.length === 0) {
        yield { kind: "not_needed", swampDir: deps.swampDir };
        return;
      }
      const data: PreV3RecordsRepairData = {
        swampDir: deps.swampDir,
        recordDirs,
        preV3RecordsDir: deps.preV3RecordsDir,
      };
      if (!options.confirm) {
        yield { kind: "preview", data };
        return;
      }

      try {
        const { destination, moved } = await deps.moveAside();
        // Another process moved them since they were found.
        if (moved.length === 0) {
          yield { kind: "not_needed", swampDir: deps.swampDir };
          return;
        }
        yield {
          kind: "completed",
          data: { ...data, recordDirs: [...moved], destination },
        };
      } catch (err) {
        yield {
          kind: "error",
          error: {
            code: err instanceof UserError && err.code
              ? err.code
              : "pre_v3_records_repair_failed",
            message: `Could not move the records aside: ${
              err instanceof Error ? err.message : String(err)
            }. Records already moved stay where they were moved; run the repair again to move the rest, into a new directory under pre-v3-records.`,
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}
