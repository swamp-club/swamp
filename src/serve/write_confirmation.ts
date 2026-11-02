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

import { SYNC_GATED_REQUESTS } from "./sync_gate.ts";

/**
 * left out: reads, model.validate, vault.put (always-local secrets),
 * control-plane workflow.* records, and datastore.claim/release whose handler
 * confirms replication itself
 */
export const CONFIRMED_WRITE_REQUESTS: ReadonlySet<string> = new Set([
  ...SYNC_GATED_REQUESTS,
  // A run's final reply reports it finished; detached runs confirm at
  // their buffer's terminal as well.
  "model.method.run",
  "workflow.run",
  "workflow.resume",
  // Persists the cancel of a suspended run, or waits for an aborted one.
  "workflow.cancel",
  // `run doctor --fix` saves the runs it repairs.
  "run.doctor",
]);
