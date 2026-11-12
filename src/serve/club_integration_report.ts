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

import type { ReportedIntegration } from "../domain/access/integration_directory.ts";

export interface IntegrationReportSource {
  reported(): readonly ReportedIntegration[] | undefined;
  onChanged(listener: () => void): () => void;
}

/**
 * functional, not usage telemetry: sent whatever the opt-outs say, so it holds
 * ids, states and dates and nothing else
 */
export function withReportedIntegrations<T extends object>(
  request: T,
  source: IntegrationReportSource,
): T & { integrations?: readonly ReportedIntegration[] } {
  const integrations = source.reported();
  return integrations === undefined ? request : { ...request, integrations };
}

// a reload replaces the heartbeat service, so look up the current one each time
export function beatOnIntegrationChange(
  source: IntegrationReportSource,
  currentHeartbeat: () => { beatNow(): void } | null,
): () => void {
  return source.onChanged(() => currentHeartbeat()?.beatNow());
}
