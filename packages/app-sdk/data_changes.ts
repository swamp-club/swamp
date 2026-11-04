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

import type { DataChangesPage } from "../client/client.ts";
import type { DataSubscribePayload } from "../client/protocol.ts";

export type DataChangesMode = "connecting" | "live" | "polling";

export interface FollowDataChanges {
  readonly filter: Pick<DataSubscribePayload, "behaviors" | "types">;
  readonly signal: AbortSignal;
  readonly pollMs: number;
  subscribe(
    payload: DataSubscribePayload,
    signal: AbortSignal,
  ): AsyncIterable<DataChangesPage>;
  /** A page of changes; empty pages (heartbeats) are not passed on. */
  onChanges(page: DataChangesPage): void;
  /** Data may have changed unseen: a poll came round, or changes were lost. */
  onStale(): void;
  onMode(mode: DataChangesMode): void;
  /** Resolves after `ms`, or as soon as the signal aborts. */
  wait(ms: number): Promise<void>;
}

const RESUBSCRIBE_MAX_MS = 10_000;

// serve says these cannot be subscribed to here, so polling stands in
const NO_FEED_CODES = new Set([
  "data_feed_unavailable",
  "app_capability_denied",
  "not_available_locally",
]);

/** Resubscribes from the last cursor after a dropped stream, and polls where serve has no change feed. */
export async function followDataChanges(follow: FollowDataChanges) {
  const { signal } = follow;
  let cursor: number | undefined;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const payload = {
        ...follow.filter,
        ...(cursor !== undefined ? { cursor } : {}),
      };
      for await (const page of follow.subscribe(payload, signal)) {
        // nothing to resume from, so what happened meanwhile is unknown
        if (cursor === undefined && failures > 0) follow.onStale();
        failures = 0;
        cursor = page.cursor;
        follow.onMode("live");
        if (page.changes.length > 0) follow.onChanges(page);
      }
      if (signal.aborted) return;
      throw new Error("The change feed ended");
    } catch (reason) {
      if (signal.aborted) return;
      const code = (reason as { code?: unknown }).code;
      if (typeof code === "string" && NO_FEED_CODES.has(code)) {
        follow.onMode("polling");
        while (!signal.aborted) {
          await follow.wait(follow.pollMs);
          if (!signal.aborted) follow.onStale();
        }
        return;
      }
      // what was missed is gone from the log, so the app reads afresh
      if (code === "commits_compacted") cursor = undefined;
      failures++;
      follow.onMode("connecting");
      await follow.wait(Math.min(RESUBSCRIBE_MAX_MS, 500 * 2 ** failures));
    }
  }
}
