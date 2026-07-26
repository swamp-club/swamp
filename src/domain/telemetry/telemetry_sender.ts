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

import type { TelemetryEntry } from "./telemetry_entry.ts";

export interface TelemetryFlushResult {
  ok: boolean;
  reason?: string;
}

/**
 * Port for sending telemetry events to a remote endpoint.
 * Implemented by infrastructure adapters (e.g. HttpTelemetrySender).
 */
export interface TelemetrySender {
  sendBatch(
    entries: TelemetryEntry[],
    distinctId: string,
    repoId?: string,
    authToken?: string,
    signal?: AbortSignal,
  ): Promise<TelemetryFlushResult>;
}
