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

import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "../../domain/telemetry/telemetry_sender.ts";
import type { TelemetryEntry } from "../../domain/telemetry/telemetry_entry.ts";

/**
 * HTTP adapter implementing TelemetrySender.
 * Sends telemetry events to a remote /ingest endpoint.
 *
 * `userAgent` (e.g. `swamp-cli/<version>`) is optional so unit tests can
 * construct the sender without it; the composition root passes it so the
 * telemetry endpoint can attribute traffic by client version, matching
 * the swamp-club API clients.
 */
export class HttpTelemetrySender implements TelemetrySender {
  constructor(
    private readonly endpointUrl: string,
    private readonly userAgent?: string,
  ) {}

  async sendBatch(
    entries: TelemetryEntry[],
    distinctId: string,
    repoId?: string,
    authToken?: string,
    signal?: AbortSignal,
  ): Promise<TelemetryFlushResult> {
    // `insert_id` is the ingest queue's idempotency key: it carries a unique
    // index, so a re-POST of an entry that was already accepted (a retry after
    // a lost 202, or a flush that raced another flusher) is deduplicated
    // instead of becoming a second queue doc. Without it the server generates
    // one per POST and the same invocation is counted twice in the downstream
    // rollups. The entry id is already a stable per-invocation UUID, which is
    // exactly the key we want.
    const events = entries.map((entry) => ({
      event: "cli_invocation",
      distinct_id: distinctId,
      insert_id: entry.id,
      properties: {
        ...entry.toData(),
        ...(repoId ? { $repo_id: repoId } : {}),
      },
    }));

    const body = events.length === 1
      ? JSON.stringify(events[0])
      : JSON.stringify({ events });

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(authToken ? { "x-api-key": authToken } : {}),
        ...(this.userAgent ? { "User-Agent": this.userAgent } : {}),
      };

      // Combine caller's signal with a hard 5-second ceiling
      const fetchSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);

      const response = await fetch(`${this.endpointUrl}/ingest`, {
        method: "POST",
        headers,
        body,
        signal: fetchSignal,
      });
      // Consume the response body to prevent resource leaks
      await response.body?.cancel();
      if (response.status === 202) {
        return { ok: true };
      }
      return { ok: false, reason: `HTTP ${response.status}` };
    } catch (error: unknown) {
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "network error" };
    }
  }
}
