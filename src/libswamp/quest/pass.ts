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
import type { GenesisPass } from "../../domain/quest/genesis_pass.ts";

export interface QuestPassData {
  readonly pass: GenesisPass;
  /** True when read via the unauthenticated ghost path (progress unclaimed). */
  readonly ghost: boolean;
}

export type QuestPassEvent =
  | { kind: "completed"; data: QuestPassData }
  | { kind: "error"; error: SwampError };

export interface QuestPassDeps {
  /** Whether this is the ghost (unauthenticated) read. */
  readonly ghost: boolean;
  /**
   * Fetches the Genesis pass. The command wires this to either the
   * authenticated read (whoami → `/api/u/:username/genesis`) or the ghost read
   * (`/api/quest/genesis/ghost`, keyed by the device distinct_id).
   */
  fetchPass: () => Promise<GenesisPass>;
}

/**
 * Fetches the operative's Genesis pass from swamp-club — the single source of
 * truth for both the authenticated and ghost reads. Which endpoint is hit is
 * decided by the caller; this generator just streams the result plus whether it
 * came from the ghost path.
 */
export async function* questPass(
  ctx: LibSwampContext,
  deps: QuestPassDeps,
): AsyncIterable<QuestPassEvent> {
  yield* withGeneratorSpan(
    "swamp.quest.pass",
    { ghost: deps.ghost },
    (async function* () {
      ctx.logger.debug`Fetching Genesis pass (ghost=${deps.ghost})`;
      const pass = await deps.fetchPass();

      yield {
        kind: "completed",
        data: { pass, ghost: deps.ghost },
      };
    })(),
  );
}
