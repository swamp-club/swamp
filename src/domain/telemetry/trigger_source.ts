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
 * set only on runs a long-lived serve started itself; CLI runs leave it
 * undefined. Not named source: the telemetry backend already derives a field by
 * that name
 */
export type WorkflowTriggerSource = "schedule" | "webhook" | "api";

export const WORKFLOW_TRIGGER_SOURCES: readonly WorkflowTriggerSource[] = [
  "schedule",
  "webhook",
  "api",
];

/**
 * a spool file can be hand-edited or written by a newer version, so decoded
 * values are not trusted to be known variants
 */
export function isWorkflowTriggerSource(
  value: unknown,
): value is WorkflowTriggerSource {
  return typeof value === "string" &&
    (WORKFLOW_TRIGGER_SOURCES as readonly string[]).includes(value);
}
