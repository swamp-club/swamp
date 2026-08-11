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
 * What caused an invocation, when it was not a human at a terminal.
 *
 * Set only on invocations a long-lived `swamp serve` produced on its own:
 * a cron-fired workflow, a verified inbound webhook, or an API/WebSocket
 * request. Interactive CLI runs leave it `undefined`, which keeps the
 * emitted event byte-identical to what the CLI has always sent.
 *
 * Deliberately NOT named `source`. The telemetry backend already derives a
 * field by that name from the recorded command, and overloading it here
 * would collide two independently-owned concerns in one key.
 */
export type WorkflowTriggerSource = "schedule" | "webhook" | "api";

/** Every valid trigger source, for validation and exhaustive iteration. */
export const WORKFLOW_TRIGGER_SOURCES: readonly WorkflowTriggerSource[] = [
  "schedule",
  "webhook",
  "api",
];

/**
 * Narrows an arbitrary value to a WorkflowTriggerSource.
 *
 * Used when decoding persisted entries: a spool file is on disk and can be
 * hand-edited or written by a newer version, so the value is not trusted to
 * be one of the known variants.
 */
export function isWorkflowTriggerSource(
  value: unknown,
): value is WorkflowTriggerSource {
  return typeof value === "string" &&
    (WORKFLOW_TRIGGER_SOURCES as readonly string[]).includes(value);
}
