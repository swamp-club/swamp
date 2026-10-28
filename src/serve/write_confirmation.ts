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
 * Which serve requests wait for their commits to be confirmed replicated
 * before they answer (swamp-club#3489, Phase 4D3). Dispatch wraps each of
 * them in `confirmRequest`; while replication is off that runs the handler
 * and nothing waits. See "Phase 4D3" in
 * `design/enablers/datastore-litestream.md`.
 *
 * @module
 */

import { SYNC_GATED_REQUESTS } from "./sync_gate.ts";

/**
 * Requests whose handler writes to the datastore and tells the client it
 * succeeded: every request gated for its push, the runs, whose final reply
 * says the run finished, and the requests that write without a push.
 *
 * Left out on purpose, because they commit nothing to the datastore or
 * acknowledge no write: reads, `model.validate` (a read; a check that
 * writes is incidental), `vault.put` (secrets stay in the always-local
 * `.swamp/secrets`), and `workflow.signal`, `workflow.trigger.*` and
 * `workflow.schedule.*` (control-plane records and serve config, outside the
 * commit log), and `datastore.claim` and `datastore.release`, whose owner row
 * is no commit, so their handler confirms it replicated itself
 * (swamp-club#4063). The integration tests
 * pin the dispatch: every request named here is wrapped, and no other.
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
