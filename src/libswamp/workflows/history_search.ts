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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import type { WorkflowRunSearchItem } from "./run_search.ts";
import { validationFailed } from "../errors.ts";

import { findReapedBefore, type ReapedBefore } from "../retention/reaped.ts";
import type { RetentionWatermarkRepository } from "../../domain/retention/retention_watermark.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { collectBounded, RUN_FANOUT_CONCURRENCY } from "./run_fanout.ts";
import {
  evaluateWorkflowRunFilter,
  validateWorkflowRunFilter,
} from "../../infrastructure/cel/workflow_run_filter.ts";
export type WorkflowHistorySearchItem = WorkflowRunSearchItem;

export interface WorkflowHistorySearchData {
  query: string;
  results: WorkflowHistorySearchItem[];
  /**
   * set when retention has reaped runs: runs older than cutoff are gone, so the
   * listing cannot show them
   */
  reapedBefore?: ReapedBefore;
}

export type WorkflowHistorySearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowHistorySearchData }
  | { kind: "error"; error: SwampError };

export interface WorkflowHistorySearchDeps {
  findAllWorkflows(): Promise<Array<{ id: string; name: string }>>;
  findAllRunsByWorkflowId(id: string): Promise<
    Array<{
      id: string;
      workflowId: string;
      workflowName: string;
      status: string;
      startedAt?: Date;
      completedAt?: Date;
      duration?: number;
      tags: Record<string, string>;
      inputs: Record<string, unknown>;
      inputsOmitted?: string[];
      instanceId?: string;
      triggerSource?: string;
      failedStep?: string;
      failureReason?: string;
      stepProgress?: { completed: number; total: number };
    }>
  >;
  /** workflowId is the workflow that listed the run, never its summary's id */
  runInputsOf(
    workflowId: string,
    runId: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined>;
  /**
   * whether the caller may read runs under this workflow id and name; a run it
   * may not read never has its record read for a filter
   */
  isReadable?(workflowId: string, workflowName: string): Promise<boolean>;
  retentionWatermarks?: RetentionWatermarkRepository;
}

export interface WorkflowHistorySearchInput {
  query?: string;
  workflow?: string;
  inputs?: Record<string, string>;
  filter?: string;
}

/**
 * each record is read, judged and let go inside the fan-out, so at most
 * RUN_FANOUT_CONCURRENCY records are held at once; its values never leave
 */
async function matchingOnRecords(
  deps: WorkflowHistorySearchDeps,
  owners: ReadonlyMap<WorkflowHistorySearchItem, string>,
  runs: readonly WorkflowHistorySearchItem[],
  matches: (
    run: WorkflowHistorySearchItem,
    inputs: Readonly<Record<string, unknown>>,
  ) => boolean,
): Promise<Set<WorkflowHistorySearchItem>> {
  const readable = new Map<string, Promise<boolean>>();
  const canRead = (run: WorkflowHistorySearchItem): Promise<boolean> => {
    if (!deps.isReadable) return Promise.resolve(true);
    const key = JSON.stringify([run.workflowId, run.workflowName]);
    let allowed = readable.get(key);
    if (allowed === undefined) {
      allowed = deps.isReadable(run.workflowId, run.workflowName);
      readable.set(key, allowed);
    }
    return allowed;
  };
  const matched = await collectBounded(
    runs,
    RUN_FANOUT_CONCURRENCY,
    async (run) => {
      if (!await canRead(run)) return [];
      const inputs = await deps.runInputsOf(owners.get(run)!, run.runId);
      return inputs !== undefined && matches(run, inputs) ? [run] : [];
    },
  );
  return new Set(matched);
}

export async function* workflowHistorySearch(
  _ctx: LibSwampContext,
  deps: WorkflowHistorySearchDeps,
  input: WorkflowHistorySearchInput,
): AsyncGenerator<WorkflowHistorySearchEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.history.search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const allWorkflows = await deps.findAllWorkflows();

      // run summaries are fetched with bounded concurrency so peak memory does
      // not scale with the number of workflows; summaries are lightweight, so
      // holding them all before filtering is cheap
      const allRuns = await collectBounded(
        allWorkflows,
        RUN_FANOUT_CONCURRENCY,
        async (workflow) =>
          (await deps.findAllRunsByWorkflowId(workflow.id)).map((run) => ({
            ...run,
            ownerId: workflow.id,
          })),
      );
      const owners = new Map<WorkflowHistorySearchItem, string>();

      allRuns.sort((a, b) => {
        const aTime = a.startedAt?.getTime() ?? 0;
        const bTime = b.startedAt?.getTime() ?? 0;
        return bTime - aTime;
      });

      let results: WorkflowHistorySearchItem[] = allRuns.map((run) => {
        const startTime = run.startedAt?.getTime();
        const endTime = run.completedAt?.getTime();
        const tags = run.tags && Object.keys(run.tags).length > 0
          ? { ...run.tags }
          : undefined;
        const inputs = run.inputs && Object.keys(run.inputs).length > 0
          ? { ...run.inputs }
          : undefined;
        const inputsOmitted = run.inputsOmitted && run.inputsOmitted.length > 0
          ? [...run.inputsOmitted]
          : undefined;

        const item: WorkflowHistorySearchItem = {
          runId: run.id,
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          status: run.status,
          startedAt: run.startedAt?.toISOString(),
          completedAt: run.completedAt?.toISOString(),
          duration: startTime && endTime ? endTime - startTime : undefined,
          tags,
          inputs,
          inputsOmitted,
          instanceId: run.instanceId,
          triggerSource: run.triggerSource,
          failedStep: run.failedStep,
          failureReason: run.failureReason,
          stepProgress: run.stepProgress,
        };
        owners.set(item, run.ownerId);
        return item;
      });

      if (input.workflow) {
        const name = input.workflow.toLowerCase();
        results = results.filter(
          (r) => r.workflowName.toLowerCase() === name,
        );
      }

      const validation = input.filter
        ? validateWorkflowRunFilter(input.filter)
        : undefined;
      if (validation && !validation.valid) {
        yield {
          kind: "error",
          error: validationFailed(
            `Invalid --filter expression: ${validation.error}`,
          ),
        };
        return;
      }

      const inputEntries = Object.entries(input.inputs ?? {});
      const filterReadsInputs = validation?.referencesInputs === true;
      const matches = (
        r: WorkflowHistorySearchItem,
        inputs: Readonly<Record<string, unknown>> | undefined,
      ) =>
        inputEntries.every(([k, v]) => String(inputs?.[k]) === v) &&
        (!input.filter || evaluateWorkflowRunFilter(input.filter, {
          workflowName: r.workflowName,
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          duration: r.duration,
          inputs: inputs ? { ...inputs } : inputs,
          tags: r.tags,
          instanceId: r.instanceId,
          triggerSource: r.triggerSource,
          failedStep: r.failedStep,
          failureReason: r.failureReason,
        }));
      const needsRecord = (r: WorkflowHistorySearchItem) =>
        r.inputsOmitted !== undefined &&
        (filterReadsInputs ||
          inputEntries.some(([k]) => r.inputsOmitted!.includes(k)));
      // An --input on a kept key rules a run out before its record is read.
      const unsure = results.filter((r) =>
        needsRecord(r) &&
        inputEntries.every(([k, v]) =>
          r.inputsOmitted!.includes(k) || String(r.inputs?.[k]) === v
        )
      );
      const onRecords = await matchingOnRecords(deps, owners, unsure, matches);
      // A run whose record was needed but is gone or unreadable matches nothing.
      results = results.filter((r) =>
        needsRecord(r) ? onRecords.has(r) : matches(r, r.inputs)
      );

      const reaped = await findReapedBefore(
        deps.retentionWatermarks,
        "workflowRuns",
      );
      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results,
          ...(reaped ? { reapedBefore: reaped } : {}),
        },
      };
    })(),
  );
}
