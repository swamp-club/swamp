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

import { shutdownTracing } from "./otel_init.ts";
import { shutdownLogs } from "./otel_logs_init.ts";
import { shutdownExecutionMetrics } from "./otel_metrics_init.ts";
import { exitDeadline } from "./otlp_export_queue.ts";

/**
 * one deadline for every signal, so a silent collector delays exit once;
 * metrics collects last so it exports the span outcomes recorded before it
 */
export async function shutdownObservability(
  deadline: number = exitDeadline(),
): Promise<void> {
  await Promise.all([shutdownLogs(deadline), shutdownTracing(deadline)]);
  await shutdownExecutionMetrics(deadline);
}
