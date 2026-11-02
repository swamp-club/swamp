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

import { observeDiagnosticPhase } from "../../domain/diagnostics/diagnostic_phase.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  sortInTimeSlices,
  TimeSlice,
} from "../../infrastructure/persistence/scan_permits.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { clampRecentLimit } from "../workflows/run_summary.ts";
import {
  definitionNamer,
  findCandidates,
  type ModelOutputSearchDeps,
  type ModelOutputSearchItem,
  type ModelOutputSearchOutput,
  nameWorkflows,
  parseInstant,
  readableSelector,
  startedInWindow,
  toSearchItem,
} from "./output_search.ts";

export type ModelUsageRecentOutput = Omit<
  ModelOutputSearchItem,
  "definitionId" | "modelName" | "type"
>;

export interface ModelUsageSummaryModel {
  definitionId: string;
  modelName: string;
  type: string;
  executions: number;
  failed: number;
  lastStartedAt: string;
  methods: string[];
  recent: ModelUsageRecentOutput[];
}

export interface ModelUsageSummaryData {
  since?: string;
  until?: string;
  /**
   * Every readable output in the window, including those of definitions
   * that no longer resolve, which have no row in `models`.
   */
  totals: { executions: number; failed: number };
  models: ModelUsageSummaryModel[];
}

export type ModelUsageSummaryEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelUsageSummaryData }
  | { kind: "error"; error: SwampError };

export interface ModelUsageOutputGroup {
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
}

export type ModelUsageSummaryDeps =
  & Pick<
    ModelOutputSearchDeps,
    | "findAllOutputsGlobal"
    | "findAllOutputsGlobalSince"
    | "findAllDefinitions"
    | "resolveModelNames"
    | "resolveWorkflowNames"
    | "canRead"
  >
  & {
    /**
     * Whether the caller may read outputs of this model and method, asked
     * once the scan is done: the final check, as the output search's
     * `authorization` is. Outputs it refuses never reach the counts, methods
     * or recent lists.
     */
    isReadable(group: ModelUsageOutputGroup): Promise<boolean>;
    definitionNameById(definitionId: string): Promise<string | undefined>;
  };

export interface ModelUsageSummaryInput {
  since?: string;
  until?: string;
  recentLimit?: number;
}

interface GroupTally extends ModelUsageOutputGroup {
  /**
   * The name its row shows: a definition's outputs recorded under a type it
   * no longer has still count on it. Authorization reads `modelName`, the
   * name under the output's own type, as the output search does.
   */
  rowName?: string;
  executions: number;
  failed: number;
  lastStartedAt: string;
  recent: ModelOutputSearchOutput[];
}

function recentOutput(
  output: ModelOutputSearchOutput,
  type: string,
): ModelUsageRecentOutput {
  const { definitionId: _id, modelName: _name, type: _type, ...recent } =
    toSearchItem(output, { normalized: type }, undefined, true);
  return recent;
}

/**
 * reads the same outputs as the output search and tallies per model and method
 * before authorizing, because the decision for one output of a method is the
 * decision for all of them
 */
export async function* modelUsageSummary(
  _ctx: LibSwampContext,
  deps: ModelUsageSummaryDeps,
  input: ModelUsageSummaryInput,
): AsyncGenerator<ModelUsageSummaryEvent> {
  yield* withGeneratorSpan(
    "swamp.model.usage.summary",
    {},
    (async function* (): AsyncGenerator<ModelUsageSummaryEvent> {
      yield { kind: "resolving" };

      const now = Date.now();
      const since = parseInstant("since", input.since, now);
      if (since !== undefined && !(since instanceof Date)) {
        yield { kind: "error", error: since };
        return;
      }
      const until = parseInstant("until", input.until, now);
      if (until !== undefined && !(until instanceof Date)) {
        yield { kind: "error", error: until };
        return;
      }
      const recentLimit = clampRecentLimit(input.recentLimit);

      const namer = definitionNamer(deps);
      const candidates = await observeDiagnosticPhase(
        "candidate_scan",
        {},
        async (phase) => {
          const found = await findCandidates(
            deps,
            undefined,
            since,
            until,
            readableSelector(namer, deps.canRead),
          );
          phase.tally.add("candidates", found.length);
          return found;
        },
      );
      const inWindow = await sortInTimeSlices(
        candidates.filter(({ output }) =>
          startedInWindow(output, since, until)
        ),
        (a, b) => b.output.startedAt.getTime() - a.output.startedAt.getTime(),
      );
      await namer.resolve(
        inWindow.map(({ output, type }) => ({
          type,
          definitionId: output.definitionId,
        })),
      );

      const groups = new Map<string, GroupTally>();
      const slice = new TimeSlice();
      for (const { output, type } of inWindow) {
        if (slice.over) await slice.next();
        const key = JSON.stringify([
          type.normalized,
          output.definitionId,
          output.methodName,
        ]);
        let group = groups.get(key);
        if (!group) {
          const modelName = await namer.nameOf(type, output.definitionId);
          group = {
            definitionId: output.definitionId,
            modelName,
            rowName: modelName ??
              await deps.definitionNameById(output.definitionId),
            type: type.normalized,
            methodName: output.methodName,
            executions: 0,
            failed: 0,
            lastStartedAt: output.startedAt.toISOString(),
            recent: [],
          };
          groups.set(key, group);
        }
        group.executions++;
        if (output.status === "failed") group.failed++;
        if (group.recent.length < recentLimit) group.recent.push(output);
      }

      const readable = await observeDiagnosticPhase(
        "authorization",
        {},
        async (phase) => {
          phase.tally.add("items", inWindow.length);
          phase.tally.add("groups", groups.size);
          phase.tally.add("readable", 0);
          const kept: GroupTally[] = [];
          for (const group of groups.values()) {
            if (await deps.isReadable(group)) {
              kept.push(group);
              phase.tally.add("readable", group.executions);
            }
          }
          return kept;
        },
      );

      const data = summarize(readable, recentLimit);
      await nameWorkflows(deps, data.models.flatMap((model) => model.recent));

      yield {
        kind: "completed",
        data: {
          ...(since ? { since: since.toISOString() } : {}),
          ...(until ? { until: until.toISOString() } : {}),
          ...data,
        },
      };
    })(),
  );
}

/**
 * outputs of an id with no definition under any type count in the totals only:
 * no page can look such a row up, and history can hold many deleted
 * definitions, so they must not grow the reply
 */
function summarize(
  groups: readonly GroupTally[],
  recentLimit: number,
): Pick<ModelUsageSummaryData, "totals" | "models"> {
  const totals = { executions: 0, failed: 0 };
  const byModel = new Map<string, GroupTally[]>();
  for (const group of groups) {
    totals.executions += group.executions;
    totals.failed += group.failed;
    if (group.rowName === undefined) continue;
    const key = JSON.stringify([group.type, group.definitionId]);
    const merged = byModel.get(key);
    if (merged) merged.push(group);
    else byModel.set(key, [group]);
  }

  const models: ModelUsageSummaryModel[] = [];
  for (const merged of byModel.values()) {
    // Groups were created in newest-first order, so the first is the newest.
    const [newest] = merged;
    models.push({
      definitionId: newest.definitionId,
      modelName: newest.rowName!,
      type: newest.type,
      executions: merged.reduce((sum, g) => sum + g.executions, 0),
      failed: merged.reduce((sum, g) => sum + g.failed, 0),
      lastStartedAt: newest.lastStartedAt,
      methods: merged.map((g) => g.methodName),
      recent: merged
        .flatMap((g) => g.recent)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, recentLimit)
        .map((output) => recentOutput(output, newest.type)),
    });
  }
  models.sort((a, b) =>
    Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt)
  );
  return { totals, models };
}
