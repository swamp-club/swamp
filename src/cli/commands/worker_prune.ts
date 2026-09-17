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
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  consumeStream,
  createLibSwampContext,
  createModelDeleteDeps,
  createWorkerListDeps,
  createWorkerModelRunDeps,
  modelDelete,
  modelMethodRun,
  parseDuration,
  withDefaults,
  workerPrune,
  type WorkerPruneDeps,
  type WorkerPruneEvent,
  type WorkerPruneResult,
  workerTokenList,
  type WorkerTokenListEvent,
} from "../../libswamp/mod.ts";
import {
  WORKER_MODEL_TYPE,
  WorkerStateSchema,
} from "../../domain/models/worker/worker_model.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  renderWorkerPrunePreview,
  renderWorkerPruneResult,
} from "../../presentation/output/worker_output.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { WorkerPruneResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const DEFAULT_GRACE_PERIOD = "24h";

export const workerPruneCommand = withRemoteOptions(
  new Command()
    .name("prune")
    .description(
      "Remove stale disconnected worker records (binding cleanup runs server-side)",
    )
    .example("Preview what would be pruned", "swamp worker prune --dry-run")
    .example("Prune with default 24h grace", "swamp worker prune --force")
    .example(
      "Prune workers disconnected for 1 hour",
      "swamp worker prune --grace-period 1h --force",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--grace-period <duration:string>",
      `Only prune workers disconnected longer than this (default: ${DEFAULT_GRACE_PERIOD})`,
    )
    .option("--dry-run", "Preview what would be pruned without deleting")
    .option("-f, --force", "Skip confirmation prompt"),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "worker",
    "prune",
  ]);

  const gracePeriodStr = (options.gracePeriod as string | undefined) ??
    DEFAULT_GRACE_PERIOD;
  let gracePeriodMs: number;
  try {
    gracePeriodMs = parseDuration(gracePeriodStr);
  } catch {
    throw new UserError(
      `Invalid --grace-period value "${gracePeriodStr}". Use a duration like "1h", "24h", or "7d".`,
    );
  }

  const dryRun = options.dryRun ?? false;

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<WorkerPruneResponse>(
      { server, token },
      {
        type: "worker.prune",
        payload: { gracePeriodMs, dryRun },
      },
    );
    renderWorkerPruneResult(
      response.data as unknown as WorkerPruneResult,
      cliCtx.outputMode,
    );
    return;
  }

  const {
    repoDir,
    repoContext,
    datastoreResolver,
    datastoreConfig,
    syncService,
    vaultsDir,
  } = await requireInitializedRepoUnlocked({
    repoDir: resolveRepoDir(options.repoDir),
    outputMode: cliCtx.outputMode,
  });

  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;

  const libCtx = createLibSwampContext({ logger: cliCtx.logger });

  const listDeps = createWorkerListDeps(repoContext.dataQueryService);

  const runDeps = await createWorkerModelRunDeps(repoDir, repoContext, {
    vaultsDir,
  });

  const deleteDeps = createModelDeleteDeps(
    repoDir,
    datastoreResolver,
    undefined,
    repoContext.markDirty,
  );

  const pruneDeps: WorkerPruneDeps = {
    listWorkers: async () => {
      const records = await repoContext.dataQueryService.query(
        `modelType == "${WORKER_MODEL_TYPE.normalized}" && name == "state-main"`,
        { loadAttributes: true },
      ) as DataRecord[];
      return records.flatMap((r) => {
        const parsed = WorkerStateSchema.safeParse(r.attributes);
        if (!parsed.success) return [];
        const s = parsed.data;
        return [{
          name: s.name,
          definitionName: `worker-${s.name}`,
          status: s.status,
          tokenName: s.tokenName,
          disconnectedAt: s.disconnectedAt,
        }];
      });
    },

    listTokens: async () => {
      const tokens: WorkerPruneDeps extends { listTokens(): Promise<infer R> }
        ? R
        : never = [];
      await consumeStream(
        workerTokenList(libCtx, listDeps),
        withDefaults<WorkerTokenListEvent>({
          completed: (event) => {
            for (const t of event.data.tokens) {
              tokens.push({
                name: t.name,
                bindings: t.bindings,
              });
            }
          },
        }),
      );
      return tokens;
    },

    deleteWorker: (definitionName) =>
      modelDelete(libCtx, deleteDeps, {
        modelIdOrName: definitionName,
        force: true,
      }),

    pruneBindings: (tokenName, machineIds) =>
      modelMethodRun(libCtx, runDeps, {
        modelIdOrName: tokenName,
        methodName: "prune_bindings",
        inputs: { machineIds },
        lastEvaluated: false,
      }),
  };

  const force = !!options.force;
  let prunableCount = 0;
  let prunableWorkers: import("../../libswamp/mod.ts").PrunableWorker[] = [];
  let result: WorkerPruneResult | undefined;

  await consumeStream(
    workerPrune(libCtx, pruneDeps, { gracePeriodMs, dryRun: true }),
    withDefaults<WorkerPruneEvent>({
      previewing: (event) => {
        prunableCount = event.workers.length;
        prunableWorkers = event.workers;
      },
      completed: (event) => {
        result = event.result;
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );

  if (dryRun) {
    renderWorkerPrunePreview(prunableWorkers, true, cliCtx.outputMode);
    return;
  }

  if (prunableCount === 0) {
    renderWorkerPruneResult(
      result ?? {
        workersDeleted: 0,
        workersFailed: 0,
        bindingsPruned: 0,
        tokensCleaned: 0,
      },
      cliCtx.outputMode,
    );
    return;
  }

  if (cliCtx.outputMode === "log" && !force) {
    renderWorkerPrunePreview(prunableWorkers, false, cliCtx.outputMode);
    const confirmed = await promptConfirmation("Proceed with pruning?");
    if (!confirmed) {
      return;
    }
  }

  result = undefined;
  await consumeStream(
    workerPrune(libCtx, pruneDeps, { gracePeriodMs, dryRun: false }),
    withDefaults<WorkerPruneEvent>({
      completed: (event) => {
        result = event.result;
      },
      error: (event) => {
        throw new UserError(event.error.message);
      },
    }),
  );

  if (result) {
    renderWorkerPruneResult(result, cliCtx.outputMode);
  }

  if (!dryRun && syncService) {
    await syncService.markDirty();
    await syncService.pushChanged({ namespace });
  }

  cliCtx.logger.debug("Worker prune command completed");
});
