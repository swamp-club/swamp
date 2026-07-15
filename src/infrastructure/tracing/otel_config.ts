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

/**
 * Parses the `OTEL_EXPORTER_OTLP_HEADERS` env var (`key=val,key=val`) into a
 * record. Shared by the trace and log exporters so both signals authenticate to
 * the collector identically. Returns an empty record when the var is unset.
 */
export function parseOtlpHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = Deno.env.get("OTEL_EXPORTER_OTLP_HEADERS");
  if (raw) {
    for (const pair of raw.split(",")) {
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        headers[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
      }
    }
  }
  return headers;
}
