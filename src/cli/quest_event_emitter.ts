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

import { emitQuestEvent, type QuestEmitDeps } from "../libswamp/mod.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import { SwampClubClient } from "../infrastructure/http/swamp_club_client.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../domain/auth/auth_credentials.ts";
import { loadIdentity } from "./load_identity.ts";
import { renderQuestCompletion } from "../presentation/renderers/quest_completion.ts";
import type { OutputMode } from "../presentation/output/output.ts";

/**
 * Best-effort quest event emission after a successful command.
 * Checks if the user is authenticated, sends the event, and renders
 * any quest completions inline. Never throws — all errors are silently
 * swallowed so the main command output is never disrupted.
 */
export async function maybeEmitQuestEvent(
  outputMode: OutputMode,
  eventType: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const credentials = await new AuthRepository().load();
    if (!credentials?.apiKey) return;

    const identity = await loadIdentity();
    const serverUrl = credentials.serverUrl ??
      Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;

    const client = new SwampClubClient(serverUrl, identity);

    const deps: QuestEmitDeps = {
      loadCredentials: () => Promise.resolve({ apiKey: credentials.apiKey }),
      submitQuestEvent: (apiKey, event, signal) =>
        client.submitQuestEvent(apiKey, event, signal),
    };

    const result = await emitQuestEvent(deps, eventType, metadata);
    if (result) {
      renderQuestCompletion(outputMode, result);
    }
  } catch {
    // Best-effort — never disrupt the main command
  }
}
