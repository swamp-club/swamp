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

// `swamp dashboard`: the dashboard for the repo it runs in, with no
// swamp serve (design/surfaces/local-dashboard.md).

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepoReadOnly,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { buildServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { ActiveRunRegistry } from "../../serve/active_run_registry.ts";
import { RunCancelRegistry } from "../../serve/run_cancel_registry.ts";
import { RunMetricsTracker } from "../../serve/run_metrics_tracker.ts";
import { ComponentHealthChecker } from "../../serve/component_health_checker.ts";
import { HealthCollector } from "../../serve/health_collector.ts";
import type { ConnectionContext } from "../../serve/handlers/shared.ts";
import {
  startLocalDashboardServer,
  trackedWorkflowRuns,
} from "../../serve/local/local_dashboard_server.ts";
import { STALE_TTL_MS } from "../../domain/models/active_run.ts";
import { HUB_TOKEN_ENV } from "../../serve/local/hub_token.ts";
import { runStart } from "./start.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Serves one repo's dashboard for the local hub: prints `{"port":N}` once
 * it listens and stops when the hub closes its stdin.
 */
async function runChild(options: AnyOptions): Promise<void> {
  const hubToken = Deno.env.get(HUB_TOKEN_ENV);
  if (!hubToken) {
    throw new UserError(
      "swamp dashboard --child is started by swamp itself. Run `swamp dashboard` instead.",
    );
  }
  // Only this process needs it: the commands its runs start never see it.
  Deno.env.delete(HUB_TOKEN_ENV);
  const cliCtx = createContext(options as GlobalOptions, ["dashboard"]);
  const repoDir = resolveRepoDir(options.repoDir);
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  const repo = await requireInitializedRepoReadOnly({
    repoDir,
    outputMode: cliCtx.outputMode,
  });

  const activeRunRegistry = new ActiveRunRegistry();
  const runTracker = RunTrackerStore.fromSwampDir(swampPath(repo.repoDir));
  const instanceId = crypto.randomUUID();
  const ctx: ConnectionContext = {
    repoDir: repo.repoDir,
    repoContext: repo.repoContext,
    datastoreConfig,
    datastoreResolver: repo.datastoreResolver,
    authConfig: buildServeAuthConfig({}),
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    runTracker,
    instanceId,
    vaultsDir: repo.vaultsDir,
    defaultVault: repo.marker?.defaultVault,
  };
  const healthCollector = new HealthCollector({
    instanceId,
    deploymentMode: "local",
    startedAt: Date.now(),
    isReady: () => true,
    activeRunRegistry,
    metricsTracker: new RunMetricsTracker(),
    componentChecker: new ComponentHealthChecker({
      checkDatastore: isCustomDatastoreConfig(datastoreConfig)
        ? undefined
        : () => new FilesystemDatastoreVerifier(datastoreConfig.path).verify(),
    }),
    workerProvider: null,
    scheduleProvider: null,
    scheduleEnabled: false,
    webhookProvider: null,
    remoteOnly: false,
  });
  ctx.healthCollector = healthCollector;

  const server = startLocalDashboardServer({
    ctx,
    healthCollector,
    hubToken,
    busy: () => activeRunRegistry.list().length > 0,
    trackedRuns: () =>
      trackedWorkflowRuns(
        runTracker.findAllRunning(),
        Date.now(),
        STALE_TTL_MS,
      ),
  });
  await Deno.stdout.write(
    new TextEncoder().encode(JSON.stringify({ port: server.port }) + "\n"),
  );

  // The hub closes stdin when it stops (or dies): stop with it.
  // Handled here: on a signal the process exits without waiting for it.
  const stdinClosed = (async () => {
    for await (const _ of Deno.stdin.readable) { /* nothing to read */ }
  })().catch(() => {});
  let interrupted!: () => void;
  const interrupt = new Promise<void>((resolve) => interrupted = resolve);
  const handle = registerShutdownHandler({ handler: () => interrupted() });
  try {
    await Promise.race([stdinClosed, interrupt]);
  } finally {
    handle.dispose();
    await server.shutdown();
  }
}

export const dashboardCommand = new Command()
  .name("dashboard")
  .description(
    "Open this repo's dashboard in your browser, with no swamp serve\n" +
      "running. It shows only this repo and does not add it to your\n" +
      "swamp start workspaces.",
  )
  .option("--repo-dir <dir:string>", "Repository directory", {
    default: Deno.env.get("SWAMP_REPO_DIR"),
  })
  .option("--no-browser", "Print the URL instead of opening a browser")
  .option("--child", "Serve one repo for the local hub", { hidden: true })
  .action(async function (options: AnyOptions) {
    if (options.child) {
      await runChild(options);
      return;
    }
    const cliCtx = createContext(options as GlobalOptions, ["dashboard"]);
    if (cliCtx.outputMode === "json") {
      throw new UserError(
        "swamp dashboard opens a page in your browser and has no JSON output. Remove --json to open it.",
      );
    }
    await runStart(options, ["dashboard"], resolveRepoDir(options.repoDir));
  });
