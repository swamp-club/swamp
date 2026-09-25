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

export interface ServeConfigRow {
  label: string;
  value: string;
  ok: boolean;
}

const UNKNOWN = "—";

/**
 * Translate a `serve.config` response into the rows the System view renders.
 *
 * The server sends `{ config: { ... } }`, with `tls`, `scheduling` and
 * `dashboard` as `{ enabled }` objects and the other flags as booleans. A
 * field that is missing or has an unexpected shape renders as a dash rather
 * than "disabled", so drift in the payload shows as unknown instead of as a
 * plausible value. Returns null when there is no config to show.
 */
export function serveConfigRows(payload: unknown): ServeConfigRow[] | null {
  if (!isRecord(payload) || !isRecord(payload.config)) return null;
  const config = payload.config;

  const rows: ServeConfigRow[] = [
    text("Port", config.port),
    flag("TLS", enabledField(config.tls)),
    text("Auth Mode", config.authMode),
    flag("Scheduling", enabledField(config.scheduling)),
    flag("Dashboard", enabledField(config.dashboard)),
    flag("Remote Only", config.remoteOnly),
    flag("Auto Resume", config.autoResume),
    flag("Hot Reload", config.hotReload),
    flag("Trust Proxy", config.trustProxy),
  ];

  if (Array.isArray(config.webhooks) && config.webhooks.length > 0) {
    rows.push({
      label: "Webhooks",
      value: `${config.webhooks.length} endpoints`,
      ok: false,
    });
  }

  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledField(value: unknown): unknown {
  return isRecord(value) ? value.enabled : undefined;
}

function text(label: string, value: unknown): ServeConfigRow {
  const shown = typeof value === "string" || typeof value === "number"
    ? String(value)
    : UNKNOWN;
  return { label, value: shown, ok: false };
}

function flag(label: string, value: unknown): ServeConfigRow {
  if (value === true) return { label, value: "enabled", ok: true };
  if (value === false) return { label, value: "disabled", ok: false };
  return { label, value: UNKNOWN, ok: false };
}
