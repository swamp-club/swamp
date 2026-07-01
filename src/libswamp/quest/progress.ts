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
import type { QuestProgress } from "../../domain/quest/quest_progress.ts";

export interface QuestProgressData {
  readonly progress: QuestProgress;
}

export type QuestProgressEvent =
  | { kind: "completed"; data: QuestProgressData }
  | { kind: "error"; error: SwampError };

export interface QuestProgressDeps {
  fetchQuestProgress: () => Promise<QuestProgressData>;
}

export async function* questProgress(
  ctx: LibSwampContext,
  deps: QuestProgressDeps,
): AsyncIterable<QuestProgressEvent> {
  yield* withGeneratorSpan(
    "swamp.quest.progress",
    {},
    (async function* () {
      ctx.logger.debug`Fetching quest progress`;

      const data = await deps.fetchQuestProgress();

      yield {
        kind: "completed",
        data,
      };
    })(),
  );
}
