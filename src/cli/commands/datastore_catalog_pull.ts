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
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { CatalogRow } from "../../infrastructure/persistence/catalog_store.ts";
import type { CatalogExportRow } from "../../domain/datastore/datastore_sync_service.ts";

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
    model_name: row.model_name,
    spec_name: row.spec_name,
    data_type: row.data_type,
    content_type: row.content_type,
    lifetime: row.lifetime,
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

    const namespaces = (options.namespaces as string)
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    if (namespaces.length === 0) {
      throw new UserError(
        "No namespaces specified. Use --namespaces to list foreign namespaces (comma-separated).",
      );
    }

    const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);

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

    const datastoreResolver = new DefaultDatastorePathResolver(
      repoDir,
      datastoreConfig,
    );
    const catalogStore = createCatalogStore(repoDir, datastoreResolver);

    let totalRows = 0;
    for (const entry of entries) {
      const catalogRows = entry.rows.map(exportRowToCatalogRow);
      catalogStore.bulkUpsertForeign(entry.namespace, catalogRows);
      totalRows += catalogRows.length;
      cliCtx.logger.info(
        "Upserted {count} row(s) from namespace {namespace}",
        { count: catalogRows.length, namespace: entry.namespace },
      );
    }

    const skipped = namespaces.filter(
      (ns) => !entries.some((e) => e.namespace === ns),
    );
    for (const ns of skipped) {
      cliCtx.logger.warn(
        "Namespace {namespace} has no catalog export (skipped)",
        { namespace: ns },
      );
    }

    catalogStore.close();

    cliCtx.logger.info(
      "Foreign catalog pull complete: {total} row(s) from {count} namespace(s)",
      { total: totalRows, count: entries.length },
    );

    if (cliCtx.outputMode === "json") {
      console.log(JSON.stringify(
        {
          pulled: entries.map((e) => ({
            namespace: e.namespace,
            rows: e.rows.length,
          })),
          skipped,
          totalRows,
        },
        null,
        2,
      ));
    }
  });
