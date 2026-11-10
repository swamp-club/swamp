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

import "../src/domain/models/models.ts";
import { z } from "zod";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { executeWorkflowWithLocks } from "../src/serve/deps.ts";
import type { WorkflowRunEvent } from "../src/libswamp/workflows/run.ts";
import { endCommand, withClientEnv } from "./serve_upstream_fixtures.ts";
import {
  registerBarrierReport,
  type WorkflowReportBarrier,
} from "./workflow_report_barrier.ts";

export type WorkflowRunWorkerRequest = {
  readonly kind: "run";
  readonly configDir: string;
  readonly repoDir: string;
  readonly env: Record<string, string | undefined>;
  readonly modelType: string;
  readonly workflowName: string;
  readonly principal: string;
  readonly count: number;
  readonly barrier?: WorkflowReportBarrier;
};

export type WorkflowRunWorkerMessage =
  | { readonly kind: "loaded" }
  | {
    readonly kind: "done";
    readonly statuses: readonly string[];
    readonly errors: readonly string[];
  }
  | { readonly kind: "failed"; readonly error: string };

declare const self: Worker;

const logging = initializeLogging({});

async function run(request: WorkflowRunWorkerRequest): Promise<void> {
  await logging;
  const type = ModelType.create(request.modelType);
  if (!modelRegistry.has(type)) {
    modelRegistry.register({
      type,
      version: "2026.01.01.1",
      methods: {
        noop: {
          description: "does nothing",
          kind: "read",
          arguments: z.object({}),
          execute: () => Promise.resolve({}),
        },
      },
    });
  }
  if (request.barrier !== undefined) {
    const { dir, label, labels, waitMs } = request.barrier;
    registerBarrierReport(dir, label, labels, waitMs);
  }
  const statuses: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < request.count; i++) {
    try {
      await withClientEnv(
        { configDir: request.configDir },
        request.env,
        ["workflow", "run"],
        async () => {
          try {
            const ctx = await requireInitializedRepoUnlocked({
              repoDir: request.repoDir,
              outputMode: "json",
            });
            const events: WorkflowRunEvent[] = [];
            await executeWorkflowWithLocks(
              request.repoDir,
              ctx.repoContext,
              ctx.datastoreConfig,
              {
                workflowIdOrName: request.workflowName,
                initiatedBy: request.principal,
              },
              new AbortController().signal,
              (event) => events.push(event),
              ctx.syncService,
              undefined,
              { syncGate: undefined },
            );
            for (const event of events) {
              if (event.kind === "completed") statuses.push(event.run.status);
              if (event.kind === "error") errors.push(event.error.message);
              if (event.kind === "report_failed") errors.push(event.error);
            }
          } finally {
            await endCommand();
          }
        },
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  self.postMessage(
    { kind: "done", statuses, errors } satisfies WorkflowRunWorkerMessage,
  );
}

self.onmessage = (event: MessageEvent<WorkflowRunWorkerRequest>) => {
  run(event.data).catch((error) =>
    self.postMessage(
      {
        kind: "failed",
        error: error instanceof Error
          ? error.stack ?? error.message
          : String(error),
      } satisfies WorkflowRunWorkerMessage,
    )
  );
};

self.postMessage({ kind: "loaded" } satisfies WorkflowRunWorkerMessage);
