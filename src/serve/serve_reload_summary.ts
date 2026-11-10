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
  ServeReloadResponse,
  ServeReloadSettingsReport,
} from "./protocol.ts";

export interface ServeReloadSummary {
  readonly info: readonly string[];
  readonly warn: readonly string[];
  readonly error: readonly string[];
}

/** The lines every reload path logs for one result, so they read alike. */
export function summarizeServeReload(
  result: ServeReloadResponse,
): ServeReloadSummary {
  if (!result.success) {
    // a failed local refresh still applied the config; say what it applied
    const lines = result.settings
      ? settingsReportLines(result.settings)
      : { info: [], warn: [] };
    return { info: lines.info, warn: lines.warn, error: [...result.errors] };
  }
  const info: string[] = [`Reloaded ${result.reloadedCount} extension type(s)`];
  const warn: string[] = [];
  if (result.workflowsReloaded) {
    info.push(
      `Refreshed ${result.workflowsReloaded} extension workflow dir(s)`,
    );
  }
  if (result.triggerOverridesChanged) {
    info.push(
      `Reloaded ${result.triggerOverridesChanged} trigger override(s) from serve.yaml`,
    );
  }
  if (result.webhooksReloaded) {
    info.push(
      `Applied ${result.webhooksReloaded} webhook route change(s) from serve.yaml`,
    );
  }
  if (result.auditSinks !== undefined) {
    info.push(`Audit sinks in force: ${result.auditSinks}`);
  }
  if (result.settings) {
    const lines = settingsReportLines(result.settings);
    for (const line of lines.info) info.push(line);
    for (const line of lines.warn) warn.push(line);
  }
  return {
    info,
    warn: [...warn, ...(result.warnings ?? []), ...result.errors],
    error: [],
  };
}

export function settingsReportLines(
  settings: ServeReloadSettingsReport,
): { info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  if (settings.applied.length > 0) {
    info.push(`Applied: ${settings.applied.join(", ")}`);
  }
  for (const entry of settings.overridden) {
    warn.push(
      `${entry.setting} changed in serve.yaml but ${entry.by} keeps it pinned; change ${entry.by} and restart to change it`,
    );
  }
  for (const entry of settings.needsRestart) {
    warn.push(`${entry.setting} changed but ${entry.reason}`);
  }
  return { info, warn };
}
