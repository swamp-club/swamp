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
  DEFAULT_OUTPUT_RETENTION_DAYS,
  DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
  DefaultRunLifecycleService,
  type RunGcResult,
} from "../../domain/data/run_lifecycle_service.ts";

export { DEFAULT_OUTPUT_RETENTION_DAYS, DEFAULT_WORKFLOW_RUN_RETENTION_DAYS };
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface RunGcData {
  workflowRunsDeleted: number;
  workflowRunBytesReclaimed: number;
  outputsDeleted: number;
  outputBytesReclaimed: number;
  totalBytesReclaimed: number;
  dryRun: boolean;
}

export type RunGcEvent =
  | { kind: "collecting" }
  | { kind: "completed"; data: RunGcData }
  | { kind: "error"; error: SwampError };

export interface RunGcInput {
  dryRun: boolean;
  workflowRunRetentionDays?: number;
  outputRetentionDays?: number;
}

export interface RunGcPreview {
  workflowRunsToDelete: number;
  workflowRunBytesReclaimable: number;
  outputsToDelete: number;
  outputBytesReclaimable: number;
  totalBytesReclaimable: number;
}

export interface RunGcDeps {
  gcAll: (options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
  }) => Promise<RunGcResult>;
}

export function createRunGcDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  markDirty?: MarkDirtyHook,
): RunGcDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
    markDirty,
  );
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    markDirty,
  );
  const service = new DefaultRunLifecycleService(workflowRunRepo, outputRepo);
  return {
    gcAll: (options) => service.gcAll(options),
  };
}

export async function runGcPreview(
  ctx: LibSwampContext,
  deps: RunGcDeps,
  input: RunGcInput,
): Promise<RunGcPreview> {
  ctx.logger.debug`Previewing run GC`;
  const result = await deps.gcAll({
    workflowRunRetentionDays: input.workflowRunRetentionDays ??
      DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
    outputRetentionDays: input.outputRetentionDays ??
      DEFAULT_OUTPUT_RETENTION_DAYS,
    dryRun: true,
  });
  return {
    workflowRunsToDelete: result.workflowRunsDeleted,
    workflowRunBytesReclaimable: result.workflowRunBytesReclaimed,
    outputsToDelete: result.outputsDeleted,
    outputBytesReclaimable: result.outputBytesReclaimed,
    totalBytesReclaimable: result.workflowRunBytesReclaimed +
      result.outputBytesReclaimed,
  };
}

export async function* runGc(
  _ctx: LibSwampContext,
  deps: RunGcDeps,
  input: RunGcInput,
): AsyncIterable<RunGcEvent> {
  yield* withGeneratorSpan(
    "swamp.run.gc",
    { "gc.dry_run": input.dryRun },
    (async function* () {
      yield { kind: "collecting" } as const;

      const result = await deps.gcAll({
        workflowRunRetentionDays: input.workflowRunRetentionDays ??
          DEFAULT_WORKFLOW_RUN_RETENTION_DAYS,
        outputRetentionDays: input.outputRetentionDays ??
          DEFAULT_OUTPUT_RETENTION_DAYS,
        dryRun: input.dryRun,
      });

      yield {
        kind: "completed" as const,
        data: {
          workflowRunsDeleted: result.workflowRunsDeleted,
          workflowRunBytesReclaimed: result.workflowRunBytesReclaimed,
          outputsDeleted: result.outputsDeleted,
          outputBytesReclaimed: result.outputBytesReclaimed,
          totalBytesReclaimed: result.workflowRunBytesReclaimed +
            result.outputBytesReclaimed,
          dryRun: result.dryRun,
        },
      };
    })(),
  );
}
