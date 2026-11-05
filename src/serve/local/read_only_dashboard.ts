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

import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { listWorkflows } from "../../domain/workflows/workflow_listing.ts";
import { buildServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { RUN_INDEX_CACHE_MAX_RUNS } from "../../infrastructure/persistence/run_index_cache.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { ActiveRunRegistry } from "../active_run_registry.ts";
import { RunCancelRegistry } from "../run_cancel_registry.ts";
import { RunIndexWarmup } from "../run_index_warmup.ts";
import type { ConnectionContext } from "../handlers/shared.ts";
import type {
  HealthCollector,
  HealthSnapshotRun,
} from "../health_collector.ts";
import {
  createLocalHealthCollector,
  trackedRunsFrom,
} from "./local_dashboard_server.ts";

/** a repo opened for reading only: no v3 writer lock, no datastore writes */
export interface ReadOnlyRepo {
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly datastoreConfig: DatastoreConfig;
  readonly datastoreResolver: DatastorePathResolver;
  readonly vaultsDir: string;
  readonly defaultVault?: string;
}

/**
 * Supplied by the composition root: opening a repo read-only, with or without
 * its extensions, is CLI bootstrap the engine must not import.
 */
export type ReadOnlyRepoOpener = (
  repoDir: string,
  options: { readonly extensions: boolean },
) => Promise<ReadOnlyRepo & { dispose(): Promise<void> }>;

export interface ReadOnlyDashboard {
  readonly context: ConnectionContext;
  readonly healthCollector: HealthCollector;
  readonly trackedRuns: () => HealthSnapshotRun[];
  /** warms the run index the dashboard's history views read */
  readonly warmup: RunIndexWarmup;
  readonly runTracker: RunTrackerStore;
}

/** what `swamp dashboard --child` serves: auth mode none over a read-only repo */
export function composeReadOnlyDashboard(
  repo: ReadOnlyRepo,
): ReadOnlyDashboard {
  const activeRunRegistry = new ActiveRunRegistry();
  const runTracker = RunTrackerStore.fromSwampDir(swampPath(repo.repoDir));
  const instanceId = crypto.randomUUID();
  const healthCollector = createLocalHealthCollector({
    instanceId,
    activeRunRegistry,
    datastoreConfig: repo.datastoreConfig,
  });
  const context: ConnectionContext = {
    repoDir: repo.repoDir,
    repoContext: repo.repoContext,
    datastoreConfig: repo.datastoreConfig,
    datastoreResolver: repo.datastoreResolver,
    authConfig: buildServeAuthConfig({}),
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    runTracker,
    instanceId,
    vaultsDir: repo.vaultsDir,
    defaultVault: repo.defaultVault,
    healthCollector,
  };
  const warmup = new RunIndexWarmup({
    listWorkflowIds: async () =>
      (await listWorkflows(repo.repoContext.workflowRepo)).map((w) => w.id),
    countRunRecords: (id, signal) =>
      repo.repoContext.workflowRunRepo.countRunRecords(
        createWorkflowId(id),
        signal,
      ),
    maxRuns: RUN_INDEX_CACHE_MAX_RUNS,
    warm: (id, signal) =>
      repo.repoContext.workflowRunRepo.runIndexSnapshot(
        createWorkflowId(id),
        signal,
      ),
  });
  return {
    context,
    healthCollector,
    trackedRuns: trackedRunsFrom(runTracker),
    warmup,
    runTracker,
  };
}
