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

import type { TelemetrySender } from "../../domain/telemetry/telemetry_sender.ts";
import type { TelemetryEntry } from "../../domain/telemetry/telemetry_entry.ts";

/**
 * HTTP adapter implementing TelemetrySender.
 * Sends telemetry events to a remote /ingest endpoint.
 */
export class HttpTelemetrySender implements TelemetrySender {
  constructor(private readonly endpointUrl: string) {}

  async sendBatch(
    entries: TelemetryEntry[],
    distinctId: string,
  ): Promise<boolean> {
    const events = entries.map((entry) => ({
      event: "cli_invocation",
      distinct_id: distinctId,
      properties: entry.toData(),
    }));

    const body = events.length === 1
      ? JSON.stringify(events[0])
      : JSON.stringify({ events });

    try {
      const response = await fetch(`${this.endpointUrl}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      // Consume the response body to prevent resource leaks
      await response.body?.cancel();
      return response.status === 202;
    } catch {
      return false;
    }
  }
}
