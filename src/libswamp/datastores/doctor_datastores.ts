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
import type { NamespaceContaminationSummary } from "../../domain/datastore/datastore_sync_service.ts";

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

/** A model type whose on-disk data is not fully represented in the catalog. */
export interface CatalogShortfall {
  typeNormalized: string;
  diskRecords: number;
  catalogRecords: number;
}

/**
 * Comparison of the local catalog index against the on-disk data walk.
 *
 * The catalog is a local index of data on disk. When the walk can see records
 * the index does not have, queries silently under-report.
 * See design/enablers/data-query.md.
 */
export interface CatalogCompletenessSummary {
  diskRecords: number;
  catalogRecords: number;
  shortfalls: ReadonlyArray<CatalogShortfall>;
}

/** How many unreadable versions the check's finding lists. */
export const UNREADABLE_VERSIONS_LISTED = 20;

/**
 * Published data versions of a v2 filesystem datastore whose stored content
 * cannot be read (swamp-club#3955). `findings` holds the first
 * {@link UNREADABLE_VERSIONS_LISTED}; the counts hold them all.
 */
export interface UnreadableVersionsSummary {
  unreadableVersions: number;
  /** Records with at least one finding. */
  records: number;
  /** Records whose latest version cannot be read: they read as empty. */
  darkRecords: number;
  findings: ReadonlyArray<UnreadableDataVersion>;
}

/** The summary of a scan's findings. */
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

/** The one-line message of the unreadable_versions check. */
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

/** The key of the record a finding belongs to. */
function recordKeyOf(
  finding: Pick<UnreadableDataVersion, "modelType" | "modelId" | "dataName">,
): string {
  return `${finding.modelType}\0${finding.modelId}\0${finding.dataName}`;
}

/** Foreign namespace objects detected under the repo's own namespace. */
export interface NamespaceContaminationFinding {
  foreignNamespaces: ReadonlyArray<{ namespace: string; objectCount: number }>;
  totalForeignObjects: number;
}

/**
 * What a v3 checkout's read model holds that it could not materialise or
 * moved aside, and the torn chunks its live records name
 * (swamp-club#3617). Each list holds the first few entries; the counts
 * hold them all.
 */
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

/**
 * A replication lineage that collection keeps because it may hold commits
 * the current lineage lacks (swamp-club#3801).
 */
export interface V3KeptLineageFinding {
  fence: number;
  replicaRoot: string;
  holder: string;
  startedAt: string;
}

/** Where the manual recovery of kept lineages is written down. */
export const KEPT_LINEAGES_RECOVERY_DOC =
  'design/enablers/datastore-litestream.md, "Recovering kept replication lineages"';

/** The finding for kept lineages, or the pass when there are none. */
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

/**
 * Whether this checkout's replication lineage can be restored, as its
 * sidecar last found (swamp-club#3935).
 */
export interface V3ReplicaRestorableFinding {
  status: "verified" | "unverified" | "broken" | "broken-copy-damaged";
  lineageFence?: number;
  txid?: string;
  checkedAt?: string;
  error?: string;
  copyCheck?: string;
}

/** Whether the replica check passes: anything but a broken lineage. */
export function replicaRestorablePassed(
  finding: V3ReplicaRestorableFinding,
): boolean {
  return finding.status === "verified" || finding.status === "unverified";
}

/** The one-line message of the replica check. */
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

/** Outcome of a `doctor datastores` scan. */
export interface DoctorDatastoresData {
  datastoreType: string;
  isCustom: boolean;
  healthFindings: DatastoreHealthFinding[];
  vaultMismatchFindings: VaultMismatchFinding[];
  contaminationFinding?: NamespaceContaminationFinding;
  catalogCompletenessFinding?: CatalogCompletenessSummary;
  /** Present when the unreadable-version check found some (swamp-club#3955). */
  unreadableVersionsFinding?: UnreadableVersionsSummary;
  /** Present when the scan ran with `retention` (swamp-club#3473). */
  retentionFinding?: RetentionCheckSummary;
  /** Present when the v3 content check found something (swamp-club#3617). */
  v3ContentFinding?: V3ContentSummary;
  /** Present when lineages are kept for recovery (swamp-club#3801). */
  v3KeptLineagesFinding?: V3KeptLineageFinding[];
  /** Present when the replica check failed (swamp-club#3935). */
  v3ReplicaRestorableFinding?: V3ReplicaRestorableFinding;
}

/** Options for a `doctor datastores` scan. */
export interface DoctorDatastoresOptions {
  /**
   * Also scan storage for items older than each kind's retention
   * (`--retention`).
   */
  retention?: boolean;
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
  /**
   * Compares the local catalog index against the on-disk walk.
   *
   * Implementations must read the catalog directly and never issue a data
   * query — querying triggers backfill, and a diagnostic that repairs what it
   * measures always reports health.
   */
  checkCatalogCompleteness?: () => Promise<CatalogCompletenessSummary | null>;
  /**
   * Every published data version whose stored content cannot be read
   * (swamp-club#3955); given only on a format 2 filesystem datastore, whose
   * files are all local (a v3 checkout is covered by `checkV3Content`).
   * Read-only, and like `checkCatalogCompleteness` it never issues a data
   * query.
   */
  checkUnreadableVersions?: () => Promise<UnreadableDataVersion[]>;
  /**
   * Scans storage for items older than each kind's retention; run only with
   * the `retention` option. Read-only.
   */
  checkRetention?: () => Promise<RetentionCheckSummary>;
  /**
   * Reads a v3 checkout's read model state for records it could not
   * materialise, checkout files it moved aside, and torn chunks; given only
   * on a v3 datastore. Read-only, from checkout-local state and chunk stats.
   */
  checkV3Content?: (config: DatastoreConfig) => Promise<V3ContentSummary>;
  /**
   * Why a v3 checkout refuses to open with the repo's current directories
   * and exclude patterns, or undefined when it opens (swamp-club#3691);
   * given only on a v3 datastore. Read-only, from checkout-local state.
   */
  checkV3Filter?: (config: DatastoreConfig) => Promise<string | undefined>;
  /**
   * The replication lineages collection keeps for recovery
   * (swamp-club#3801); given only on a v3 datastore. Read-only, from the
   * datastore's lineage records.
   */
  checkV3KeptLineages?: (
    config: DatastoreConfig,
  ) => Promise<V3KeptLineageFinding[]>;
  /**
   * Whether this checkout's replication lineage can be restored, as its
   * sidecar last found (swamp-club#3935), or undefined while the datastore
   * does not replicate; given only on a v3 datastore. Read-only, from the
   * checkout's own copy.
   */
  checkV3ReplicaRestorable?: (
    config: DatastoreConfig,
  ) => Promise<V3ReplicaRestorableFinding | undefined>;
}

/** Whether the v3 content check found nothing. */
export function v3ContentPassed(summary: V3ContentSummary): boolean {
  return summary.unreadableRecords === 0 && summary.atRiskCopies === 0 &&
    summary.tornChunks === 0;
}

/** The one-line message of the v3 content check. */
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

/** The first keys of a list and how many more there are. */
function firstOf(keys: readonly string[], total: number): string {
  const shown = keys.slice(0, 3);
  const more = total - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/** The one-line message of the retention check. */
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
      let catalogCompletenessFinding: CatalogCompletenessSummary | undefined;
      let unreadableVersionsFinding: UnreadableVersionsSummary | undefined;
      let retentionFinding: RetentionCheckSummary | undefined;
      let v3ContentFinding: V3ContentSummary | undefined;
      let v3KeptLineagesFinding: V3KeptLineageFinding[] | undefined;
      let v3ReplicaRestorableFinding: V3ReplicaRestorableFinding | undefined;

      // Health check
      const { healthy, message } = await deps.checkHealth(config);
      healthFindings.push({
        check: "health",
        passed: healthy,
        message,
      });

      // A namespace named after a layout directory shares that directory
      // with the solo layout, so the un-migrated data check below cannot
      // tell the two apart and is skipped.
      // On v3 every reserved name collides: the checkout materialises the
      // namespace at .swamp/<name> (swamp-club#3691).
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
          // A v3 checkout refuses to open on a reserved name, and the v2
          // steps to move off it are refused on v3 (swamp-club#3691).
          message: config.format === 3 &&
              isReservedNamespaceName(config.namespace)
            ? reservedV3NamespaceMessage(config.namespace)
            : layoutCollisionMessage(config.namespace),
        });
      }

      // Un-migrated namespace data check
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

      // Unreadable data versions (swamp-club#3955). A scan that fails fails
      // this check on its own; the other checks still report. It runs before
      // the completeness walk, so the versions it reports are not warned
      // about again when that walk reads them.
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

      // A v3 checkout whose directories changed refuses to open
      // (swamp-club#3691): reported here, and the checks below that open
      // it are skipped.
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
        // The scan opens the repository, which a checkout swamp refuses to
        // open (a v3 one on a reserved namespace, swamp-club#3691) cannot:
        // that refusal is this check's finding, and the others still report.
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

      // v3 content check — checkout-local state only (swamp-club#3617).
      // A check that cannot read the state (a read-only state directory,
      // where SQLite cannot create the WAL's shared-memory file) fails on
      // its own; the other checks still report.
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

      // Kept replication lineages (swamp-club#3801): reported on every run,
      // since chunk collection waits on them until an operator acts.
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

      // The writer's check of its own replica (swamp-club#3935).
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

const REPAIR_STEPS = 5;

/**
 * Detect and repair namespace contamination in a datastore.
 *
 * Without `confirm`, yields a preview of what would be cleaned up.
 * With `confirm`, executes the repair sequence:
 *   1. Delete foreign objects and rebuild the remote namespace index
 *   2. Wipe the local cache
 *   3. Re-pull with namespace scoping
 *   4. Invalidate workflow run indexes
 *   5. Invalidate the data catalog
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

      let lastCompletedStep = 0;
      try {
        // Step 1: Delete foreign objects + rebuild remote index
        yield {
          kind: "step",
          step: 1,
          total: REPAIR_STEPS,
          description:
            `Deleting ${detection.totalForeignObjects} foreign objects and rebuilding namespace index`,
        };
        const result = await deps.deleteContamination();
        lastCompletedStep = 1;

        // Step 2: Wipe local cache
        yield {
          kind: "step",
          step: 2,
          total: REPAIR_STEPS,
          description: "Wiping local cache",
        };
        await deps.wipeLocalCache();
        lastCompletedStep = 2;

        // Step 3: Re-pull scoped
        yield {
          kind: "step",
          step: 3,
          total: REPAIR_STEPS,
          description: `Re-pulling data (scoped to ${config.namespace}/)`,
        };
        const filesPulled = await deps.pullScoped();
        lastCompletedStep = 3;

        // Step 4: Invalidate workflow run indexes
        yield {
          kind: "step",
          step: 4,
          total: REPAIR_STEPS,
          description: "Invalidating workflow run indexes",
        };
        const indexesInvalidated = await deps.invalidateWorkflowRunIndexes();
        lastCompletedStep = 4;

        // Step 5: Invalidate data catalog
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
        const message = err instanceof Error ? err.message : String(err);
        yield {
          kind: "error",
          error: {
            code: "repair_failed",
            message:
              `Repair failed at step ${
                lastCompletedStep + 1
              }/${REPAIR_STEPS}: ${message}. ` +
              (lastCompletedStep >= 2
                ? `Local cache was wiped — run 'swamp datastore sync --pull' to restore.`
                : lastCompletedStep >= 1
                ? `Foreign objects were deleted but local cache was not refreshed — run 'swamp datastore sync --pull' to restore.`
                : `No changes were made.`),
            cause: err instanceof Error ? err : undefined,
          },
        };
      }
    })(),
  );
}

// ============================================================================
// Repair: root-level unmigrated data cleanup
// ============================================================================

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
  /** The repo's configured datastore-tier directories. */
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

// ============================================================================
// Repair: unreadable data versions (swamp-club#3955)
// ============================================================================

/** One record the repair rolls back to its last readable version. */
export interface UnreadableRecordRepair {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  /** The unreadable versions removed, highest first. */
  removeVersions: number[];
  /** Whether the record's latest marker names no version. */
  markerUnreadable: boolean;
  /**
   * The version left as latest, or null when no readable version is left
   * and the record is removed (or, when only its marker is unreadable,
   * left as it is).
   */
  becomesLatest: number | null;
}

/** What the unreadable-version repair did. */
export interface UnreadableVersionsRepairResult {
  records: UnreadableRecordRepair[];
  versionsRemoved: number;
  /** Records left with no readable version, removed with their versions. */
  recordsRemoved: number;
  /**
   * Versions the preview listed that were readable again by the time the
   * repair held the lock, and were kept.
   */
  versionsKept: number;
}

export type RepairUnreadableVersionsEvent =
  | { kind: "scanning" }
  | { kind: "preview"; records: UnreadableRecordRepair[] }
  | { kind: "step"; description: string }
  | { kind: "completed"; result: UnreadableVersionsRepairResult }
  | { kind: "not_needed" }
  | { kind: "error"; error: SwampError };

/** A record, as the repair's operations name it. */
export interface UnreadableRecordKey {
  modelType: string;
  modelId: string;
  dataName: string;
}

/** What the repair does under the affected models' locks. */
export interface UnreadableVersionsRepairOps {
  /** The same scan as the check, read again under the locks. */
  scan: () => Promise<UnreadableDataVersion[]>;
  /**
   * Removes one version through the repository's single-version delete,
   * which drops its catalog row, recomputes the latest flags and moves the
   * marker to the highest promoted version left.
   */
  removeVersion: (
    record: UnreadableRecordKey,
    version: number,
  ) => Promise<void>;
  /**
   * Points the record's latest marker at its highest readable promoted
   * version; resolves with it, or null when none can be read.
   */
  resetLatestMarker: (record: UnreadableRecordKey) => Promise<number | null>;
}

export interface RepairUnreadableVersionsDeps {
  /** The check's scan: read-only, no locks. */
  scan: () => Promise<UnreadableDataVersion[]>;
  /**
   * Opens the repository for writing, takes the per-model locks of
   * `models`, runs `fn`, and releases the locks in a `finally`, so a repair
   * that fails never leaves a model locked against a running serve.
   */
  underModelLocks: <T>(
    models: ReadonlyArray<{ modelType: string; modelId: string }>,
    fn: (ops: UnreadableVersionsRepairOps) => Promise<T>,
  ) => Promise<T>;
}

/** The records a scan's findings roll back, in the findings' order. */
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

/**
 * Detect and repair published data versions whose stored content cannot be
 * read, by rolling each affected record back to its last readable version.
 *
 * Without `confirm`, yields a preview: per record, the versions removed and
 * the version left as latest. With `confirm`, takes the affected models'
 * locks, scans again under them, and for each record the preview listed
 * removes its unreadable versions highest first through the repository's
 * single-version delete, then points its latest marker at its highest
 * readable version. A version readable again by then is kept. Only content
 * that is already unreadable is removed.
 */
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
            for (const version of removeVersions) {
              await ops.removeVersion(record, version);
              versionsRemoved++;
            }
            // The delete moves the marker to the highest promoted version
            // left, which a crashed write that was never published can be;
            // the marker is pointed at the highest readable one instead.
            const becomesLatest = await ops.resetLatestMarker(record);
            if (becomesLatest === null && removeVersions.length > 0) {
              recordsRemoved++;
            }
            repaired.push({
              ...current,
              removeVersions,
              markerUnreadable,
              becomesLatest,
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

// ============================================================================
// Repair: local catalog index rebuild
// ============================================================================

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
  /** Removes the catalog database so the next query rebuilds it from disk. */
  invalidateCatalog: () => Promise<void>;
}

/**
 * Detect and repair a local catalog index that under-reports what is on disk.
 *
 * Repair is a deletion, not a rebuild: the catalog database is removed and the
 * next data query backfills it from the on-disk walk. That keeps the repair
 * honest — it cannot paper over a walk that is still wrong — but it also drops
 * foreign-namespace rows, which only `swamp datastore catalog pull` can
 * restore, so the caller is told.
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

// ============================================================================
// Repair: duplicate is_latest rows
// ============================================================================

export interface CatalogDuplicateLatestResult {
  /** Catalog rows whose latest flags were corrected. */
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

// ============================================================================
// Repair: a v3 datastore's lost format marker (swamp-club#3617)
// ============================================================================

/** How a v3 datastore's format marker was lost: missing, or left blank. */
export type LostFormatMarkerState = "absent" | "blank";

/** What {@link repairDatastoreFormatMarker} found, or restored. */
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
  /** The filesystem v3 datastore whose marker is restored. */
  datastorePath: string;
  markerPath: string;
  /**
   * How its marker is lost, or undefined when it is not. Stats the commit
   * log and never opens it.
   */
  inspect: () => Promise<LostFormatMarkerState | undefined>;
  /** Restores the marker; resolves with its path. */
  restore: () => Promise<string>;
}

/**
 * Restores the format marker a crash lost from a filesystem v3 datastore
 * (swamp-club#3617), for `swamp doctor datastores --repair` in a repository
 * whose config says format 3. Without `confirm` it previews what it found,
 * having opened nothing in the datastore; with it, it restores the marker.
 */
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

/** What {@link repairPreV3Records} found, or moved. */
export interface PreV3RecordsRepairData {
  /** The checkout's `.swamp/`. */
  swampDir: string;
  /** The record directories found or moved, relative to `swampDir`. */
  recordDirs: string[];
  /**
   * Where they were moved: a new directory under `.swamp/pre-v3-records/`.
   * Absent in a preview, which only names the parent.
   */
  destination?: string;
  /** The parent of every run's destination. */
  preV3RecordsDir: string;
}

export type RepairPreV3RecordsEvent =
  | { kind: "inspecting" }
  | { kind: "preview"; data: PreV3RecordsRepairData }
  | { kind: "completed"; data: PreV3RecordsRepairData }
  | { kind: "not_needed"; swampDir: string }
  | { kind: "error"; error: SwampError };

export interface RepairPreV3RecordsDeps {
  /** The checkout's `.swamp/`. */
  swampDir: string;
  /** Where a run's records go: `.swamp/pre-v3-records/`. */
  preV3RecordsDir: string;
  /**
   * The record directories a checkout that has never opened its v3
   * datastore holds, relative to `swampDir`; empty when it has v3 state or
   * holds none.
   */
  inspect: () => Promise<string[]>;
  /** Moves them aside; resolves with where to and what was moved. */
  moveAside: () => Promise<{ destination: string; moved: readonly string[] }>;
}

/**
 * Moves aside the records of a checkout that joined a v3 datastore through
 * `.swamp.yaml` while its `.swamp/` held them (swamp-club#3690), for
 * `swamp doctor datastores --repair`. A v3 datastore starts empty, so the
 * first v3 open refuses such a checkout; once its records are under
 * `.swamp/pre-v3-records/`, the next command catches up from the datastore.
 * Without `confirm` it previews what it found, having moved nothing.
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
