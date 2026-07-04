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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DataRecord } from "../domain/data/data_record.ts";
import {
  createLibSwampContext,
  createWorkerModelRunDeps,
  modelMethodRun,
} from "../libswamp/mod.ts";
import { STEP_LEASE_MODEL_TYPE } from "../domain/models/worker/step_lease_model.ts";
import { PENDING_DISPATCH_MODEL_TYPE } from "../domain/models/worker/pending_dispatch_model.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../domain/models/worker/worker_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "boot-reconciliation"]);

export interface TransitionInput {
  typeArg: string;
  definitionName: string;
  methodName: string;
  inputs: Record<string, unknown>;
}

export interface BootReconciliationDeps {
  repoDir: string;
  repoContext: RepositoryContext;
  runTransition?: (input: TransitionInput) => Promise<void>;
}

export interface SweepResult {
  leases: number;
  pendingDispatches: number;
  workers: number;
}

async function defaultRunTransition(
  repoDir: string,
  repoContext: RepositoryContext,
  input: TransitionInput,
): Promise<void> {
  const runDeps = await createWorkerModelRunDeps(repoDir, repoContext);
  for await (
    const event of modelMethodRun(createLibSwampContext({}), runDeps, {
      modelIdOrName: input.definitionName,
      methodName: input.methodName,
      inputs: input.inputs,
      lastEvaluated: false,
      typeArg: input.typeArg,
      definitionName: input.definitionName,
      skipAllReports: true,
    })
  ) {
    if (event.kind === "error") {
      const detail = event.error;
      const message = typeof detail === "object" && detail !== null &&
          "message" in detail
        ? String((detail as { message: unknown }).message)
        : String(detail);
      throw new Error(message);
    }
  }
}

export async function sweepStaleRecords(
  deps: BootReconciliationDeps,
): Promise<SweepResult> {
  const transition = deps.runTransition ??
    ((input: TransitionInput) =>
      defaultRunTransition(deps.repoDir, deps.repoContext, input));

  const result: SweepResult = { leases: 0, pendingDispatches: 0, workers: 0 };

  const activeLeases = await deps.repoContext.dataQueryService.query(
    `modelType == "${STEP_LEASE_MODEL_TYPE.normalized}" && ` +
      `attributes.state == "active"`,
    { loadAttributes: true },
  ) as DataRecord[];

  for (const lease of activeLeases) {
    const leaseId = lease.attributes?.leaseId;
    if (typeof leaseId !== "string") continue;
    try {
      await transition({
        typeArg: STEP_LEASE_MODEL_TYPE.normalized,
        definitionName: lease.modelName,
        methodName: "expire",
        inputs: { leaseId, error: "orchestrator restart" },
      });
      result.leases++;
    } catch (err) {
      logger.warn("Failed to expire stale lease {leaseId}: {error}", {
        leaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const waitingDispatches = await deps.repoContext.dataQueryService.query(
    `modelType == "${PENDING_DISPATCH_MODEL_TYPE.normalized}" && ` +
      `attributes.state == "waiting"`,
    { loadAttributes: true },
  ) as DataRecord[];

  for (const pd of waitingDispatches) {
    const queueId = pd.attributes?.queueId;
    if (typeof queueId !== "string") continue;
    try {
      await transition({
        typeArg: PENDING_DISPATCH_MODEL_TYPE.normalized,
        definitionName: pd.modelName,
        methodName: "orphan",
        inputs: { queueId, endedAt: new Date().toISOString() },
      });
      result.pendingDispatches++;
    } catch (err) {
      logger.warn(
        "Failed to orphan stale pending dispatch {queueId}: {error}",
        {
          queueId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  const staleWorkers = await deps.repoContext.dataQueryService.query(
    `modelType == "${WORKER_MODEL_TYPE.normalized}" && ` +
      `name == "state-main" && ` +
      `attributes.status != "disconnected"`,
    { loadAttributes: true },
  ) as DataRecord[];

  for (const w of staleWorkers) {
    const workerName = w.attributes?.name;
    if (typeof workerName !== "string") continue;
    try {
      await transition({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(workerName),
        methodName: "set_status",
        inputs: { status: "disconnected" },
      });
      result.workers++;
    } catch (err) {
      logger.warn(
        "Failed to disconnect stale worker {workerName}: {error}",
        {
          workerName,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return result;
}
