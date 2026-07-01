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

import type { QuestEventResult } from "../../domain/quest/quest_event.ts";

export interface QuestEmitDeps {
  loadCredentials: () => Promise<{ apiKey: string } | undefined>;
  submitQuestEvent: (
    apiKey: string,
    event: { type: string; metadata?: Record<string, unknown> },
    signal: AbortSignal,
  ) => Promise<QuestEventResult>;
}

/**
 * Best-effort quest event emission. POSTs the event to the backend
 * and returns the result if any objectives were completed.
 * Returns null on any error (network, auth, timeout).
 * Never throws.
 */
export async function emitQuestEvent(
  deps: QuestEmitDeps,
  eventType: string,
  metadata?: Record<string, unknown>,
): Promise<QuestEventResult | null> {
  try {
    const credentials = await deps.loadCredentials();
    if (!credentials) return null;

    const signal = AbortSignal.timeout(3_000);
    const result = await deps.submitQuestEvent(
      credentials.apiKey,
      { type: eventType, metadata },
      signal,
    );

    const hasCompletions = result.objectives_completed.length > 0 ||
      result.lines_completed.length > 0 ||
      result.quest_completed;

    return hasCompletions ? result : null;
  } catch {
    return null;
  }
}
