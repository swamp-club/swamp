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
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { QuestHistoryEntry } from "../../domain/quest/quest_progress.ts";

export interface QuestHistoryData {
  readonly seasons: QuestHistoryEntry[];
}

export type QuestHistoryEvent =
  | { kind: "completed"; data: QuestHistoryData }
  | { kind: "error"; error: SwampError };

export interface QuestHistoryDeps {
  fetchQuestHistory: () => Promise<QuestHistoryData>;
}

export async function* questHistory(
  ctx: LibSwampContext,
  deps: QuestHistoryDeps,
): AsyncIterable<QuestHistoryEvent> {
  yield* withGeneratorSpan(
    "swamp.quest.history",
    {},
    (async function* () {
      ctx.logger.debug`Fetching quest history`;

      const data = await deps.fetchQuestHistory();

      yield {
        kind: "completed",
        data,
      };
    })(),
  );
}
