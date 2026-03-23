// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { ActivitySummary } from "../../domain/summary/summary_types.ts";
import { SummaryService } from "../../domain/summary/summary_service.ts";
import type { OutputRepository } from "../../domain/models/repositories.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../../domain/workflows/repositories.ts";
import type { DataRepositoryReader } from "../../domain/summary/summary_types.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/**
 * Data structure for the summarise output.
 */
export type SummariseData =
  | { status: "summary"; summary: ActivitySummary; sinceLabel: string }
  | { status: "no_activity"; sinceLabel: string };

export type SummariseEvent =
  | { kind: "completed"; data: SummariseData }
  | { kind: "error"; error: SwampError };

/** Input for the summarise operation. */
export interface SummariseInput {
  since: Date;
  sinceLabel: string;
}

/** Dependencies for the summarise operation. */
export interface SummariseDeps {
  summarise: (cutoffDate: Date) => Promise<ActivitySummary>;
}

/** Wires real infrastructure into SummariseDeps. */
export function createSummariseDeps(repos: {
  outputRepo: OutputRepository;
  workflowRunRepo: WorkflowRunRepository;
  dataRepo: DataRepositoryReader;
  definitionRepo?: DefinitionRepository;
  workflowRepo?: WorkflowRepository;
}): SummariseDeps {
  const service = new SummaryService(
    repos.outputRepo,
    repos.workflowRunRepo,
    repos.dataRepo,
    repos.definitionRepo,
    repos.workflowRepo,
  );
  return {
    summarise: (cutoffDate) => service.summarise(cutoffDate),
  };
}

/** Generates an activity summary for the repository. */
export async function* summarise(
  ctx: LibSwampContext,
  deps: SummariseDeps,
  input: SummariseInput,
): AsyncIterable<SummariseEvent> {
  ctx.logger.debug`Generating activity summary since ${input.sinceLabel}`;

  const summary = await deps.summarise(input.since);

  const hasActivity = summary.methodExecutions.length > 0 ||
    summary.workflows.length > 0 ||
    summary.data.totalItems > 0;

  if (!hasActivity) {
    yield {
      kind: "completed",
      data: { status: "no_activity", sinceLabel: input.sinceLabel },
    };
    return;
  }

  yield {
    kind: "completed",
    data: {
      status: "summary",
      summary,
      sinceLabel: input.sinceLabel,
    },
  };
}
