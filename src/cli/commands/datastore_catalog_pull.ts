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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import type {
  CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import type {
  CatalogExportEntry,
  CatalogExportRow,
} from "../../domain/datastore/datastore_sync_service.ts";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import {
  acceptForeignExportRows,
  parseForeignNamespaces,
} from "../../domain/data/foreign_catalog_export.ts";
import { lifecycleFromColumn } from "../../domain/data/data_metadata.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function exportRowToCatalogRow(row: CatalogExportRow): CatalogRow {
  return {
    namespace: row.namespace,
    type_normalized: row.type_normalized,
    model_id: row.model_id,
    data_name: row.data_name,
    id: row.id,
    version: row.version,
    is_latest: row.is_latest,
    // Exports from before swamp-club#2520 have no is_step_latest, and their
    // is_latest already means latest-per-step.
    is_step_latest: row.is_step_latest ?? row.is_latest,
    model_name: row.model_name,
    spec_name: row.spec_name,
    data_type: row.data_type,
    content_type: row.content_type,
    lifetime: row.lifetime,
    garbage_collection: row.garbage_collection ?? "",
    // A missing (pre-column export) or unrecognised value is unknown, never
    // assumed active: older exports hold write-through deletion markers.
    lifecycle: lifecycleFromColumn(row.lifecycle ?? ""),
    owner_type: row.owner_type,
    streaming: row.streaming,
    size: row.size,
    created_at: row.created_at,
    tags: row.tags,
    owner_ref: row.owner_ref,
    workflow_run_id: row.workflow_run_id,
    workflow_name: row.workflow_name,
    job_name: row.job_name,
    step_name: row.step_name,
    source: row.source,
  };
}

/**
 * Converts a foreign namespace's catalog export into catalog rows and
 * recomputes both latest flags over the rows the export flagged, so an
 * export from an older swamp version — one is_latest per workflow step —
 * imports with a single is_latest per data name (swamp-club#2520). Rows the
 * export left unflagged stay unflagged.
 */
export function exportRowsToCatalogRows(
  rows: readonly CatalogExportRow[],
): CatalogRow[] {
  const catalogRows = rows.map(exportRowToCatalogRow);
  computeLatestFlags(
    catalogRows.filter((r) => r.is_latest === 1 || r.is_step_latest === 1),
  );
  return catalogRows;
}

/** What {@link storeForeignCatalogEntries} stored from one namespace's export. */
export interface StoredForeignCatalog {
  namespace: Namespace;
  /** Rows written to the catalog. */
  stored: number;
  /** Rows the export attributed to another namespace, which were dropped. */
  rejected: number;
}

/** The outcome of storing the exports a foreign catalog pull returned. */
export interface StoreForeignCatalogsResult {
  stored: StoredForeignCatalog[];
  /** Namespaces the provider returned an export for that were not requested. */
  unrequested: string[];
  /** Requested namespaces the provider returned no export for. */
  missing: Namespace[];
}

/**
 * Stores the exports a foreign catalog pull returned. Only exports of the
 * requested namespaces are stored, and of each only the rows that belong to
 * it, so one namespace's export cannot write rows under the reader's
 * namespace or any other (swamp-club#3636). `requested` must come from
 * {@link parseForeignNamespaces}, which never yields the reader's own
 * namespace.
 */
export function storeForeignCatalogEntries(
  entries: readonly CatalogExportEntry[],
  requested: readonly Namespace[],
  catalogStore: Pick<CatalogStore, "bulkUpsertForeign">,
): StoreForeignCatalogsResult {
  const stored: StoredForeignCatalog[] = [];
  const unrequested: string[] = [];
  for (const entry of entries) {
    const namespace = requested.find((ns) => ns === entry.namespace);
    if (namespace === undefined) {
      unrequested.push(entry.namespace);
      continue;
    }
    const accepted = acceptForeignExportRows(namespace, entry.rows);
    const catalogRows = exportRowsToCatalogRows(accepted.rows);
    catalogStore.bulkUpsertForeign(namespace, catalogRows);
    stored.push({
      namespace,
      stored: catalogRows.length,
      rejected: accepted.rejected,
    });
  }
  const missing = requested.filter(
    (ns) => !entries.some((e) => e.namespace === ns),
  );
  return { stored, unrequested, missing };
}

export const datastoreCatalogPullCommand = new Command()
  .description("Pull catalog metadata from foreign namespaces")
  .example(
    "Pull catalog from two namespaces",
    "swamp datastore catalog pull --namespaces infra,security",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--namespaces <namespaces:string>",
    "Comma-separated list of foreign namespaces to pull",
    { required: true },
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "datastore",
      "catalog",
      "pull",
    ]);
    const repoDir = resolveRepoDir(options.repoDir);
    cliCtx.logger.debug("Executing datastore catalog pull command");

    const requestedNamespaces = (options.namespaces as string)
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    if (requestedNamespaces.length === 0) {
      throw new UserError(
        "No namespaces specified. Use --namespaces to list foreign namespaces (comma-separated).",
      );
    }

    const { datastoreConfig, engine } = await resolveDatastoreForRepo(repoDir);

    // A v3 checkout reads every namespace from its commit log
    // (swamp-club#3534).
    if (isCustomDatastoreConfig(datastoreConfig) && engine === "v3") {
      throw new UserError(
        "Catalog pull is only for format 2 datastores. This is a format 3 " +
          "(v3) datastore, whose checkouts read their data from its commit " +
          "log, so there is no catalog to pull.",
      );
    }

    if (!isCustomDatastoreConfig(datastoreConfig)) {
      throw new UserError(
        "Catalog pull requires a remote datastore (e.g. S3). " +
          "Filesystem datastores don't need catalog synchronization.",
      );
    }

    await datastoreTypeRegistry.ensureLoaded();
    await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
    const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
    if (!typeInfo?.createProvider) {
      throw new UserError(
        `Datastore type "${datastoreConfig.type}" is not registered or has no provider.`,
      );
    }
    const provider = typeInfo.createProvider(datastoreConfig.config);

    if (!datastoreConfig.cachePath) {
      throw new UserError(
        "Datastore has no cache path configured. Cannot create sync service.",
      );
    }

    const datastoreResolver = new DefaultDatastorePathResolver(
      repoDir,
      datastoreConfig,
    );
    // Checked before the provider is contacted, against the namespace that
    // stamps this repository's own catalog rows.
    const namespaces = parseForeignNamespaces(
      requestedNamespaces,
      namespaceFromResolver(datastoreResolver),
    );

    const syncService = provider.createSyncService?.(
      repoDir,
      datastoreConfig.cachePath,
    );

    if (!syncService?.pullForeignCatalogs) {
      throw new UserError(
        `Datastore type "${datastoreConfig.type}" does not support foreign catalog pull. ` +
          "Update the extension to a version that implements pullForeignCatalogs.",
      );
    }

    cliCtx.logger.info("Pulling catalogs from {count} namespace(s)...", {
      count: namespaces.length,
    });

    const entries = await syncService.pullForeignCatalogs(namespaces);

    const catalogStore = createCatalogStore(repoDir, datastoreResolver);
    let result: StoreForeignCatalogsResult;
    try {
      result = storeForeignCatalogEntries(entries, namespaces, catalogStore);
    } finally {
      catalogStore.close();
    }

    for (const ns of result.unrequested) {
      cliCtx.logger.warn(
        "Ignored a catalog export for namespace {namespace}, which was not requested",
        { namespace: ns },
      );
    }
    let totalRows = 0;
    for (const entry of result.stored) {
      totalRows += entry.stored;
      cliCtx.logger.info(
        "Upserted {count} row(s) from namespace {namespace}",
        { count: entry.stored, namespace: entry.namespace },
      );
      if (entry.rejected > 0) {
        cliCtx.logger.warn(
          "Dropped {count} row(s) from the catalog export of namespace {namespace}: they name another namespace",
          { count: entry.rejected, namespace: entry.namespace },
        );
      }
    }
    for (const ns of result.missing) {
      cliCtx.logger.warn(
        "Namespace {namespace} has no catalog export (skipped)",
        { namespace: ns },
      );
    }

    cliCtx.logger.info(
      "Foreign catalog pull complete: {total} row(s) from {count} namespace(s)",
      { total: totalRows, count: result.stored.length },
    );

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify(
        {
          pulled: result.stored.map((e) => ({
            namespace: e.namespace,
            rows: e.stored,
            rejectedRows: e.rejected,
          })),
          skipped: result.missing,
          ignored: result.unrequested,
          totalRows,
        },
        null,
        2,
      ));
    }
  });
