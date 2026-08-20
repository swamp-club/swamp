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

export type OtlpSignal = "traces" | "logs" | "metrics";

/** Resolves the complete OTLP/HTTP endpoint for a signal. */
export function resolveOtlpEndpoint(
  signal: OtlpSignal,
  config?: { genericEndpoint?: string; signalEndpoint?: string },
): string | undefined {
  const signalName = signal.toUpperCase();
  const signalEndpoint = config
    ? config.signalEndpoint
    : Deno.env.get(`OTEL_EXPORTER_OTLP_${signalName}_ENDPOINT`);
  if (signalEndpoint) return signalEndpoint;

  const genericEndpoint = config
    ? config.genericEndpoint
    : Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!genericEndpoint) return undefined;

  return `${genericEndpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

/**
 * Parses the signal-specific or generic OTLP headers (`key=val,key=val`) into a
 * record. Signal-specific headers replace generic headers when set.
 */
export function parseOtlpHeaders(
  signal: OtlpSignal,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const signalName = signal.toUpperCase();
  const raw = Deno.env.get(`OTEL_EXPORTER_OTLP_${signalName}_HEADERS`) ||
    Deno.env.get("OTEL_EXPORTER_OTLP_HEADERS");
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
