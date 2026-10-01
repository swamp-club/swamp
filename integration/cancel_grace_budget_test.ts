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
 * Pins how the cancellation graces of the process executor, the workflow
 * engine, the cancel commands and serve relate (swamp-club#2918). Each is a
 * constant owned by a different layer; a change to one must not silently
 * outgrow another that budgets on it.
 */

import { assert } from "@std/assert";
import { KILL_GRACE_MS } from "../src/infrastructure/process/process_executor.ts";
import {
  CLEANUP_GRACE_TIMEOUT_MS,
  STEP_STOP_GRACE_MS,
} from "../src/domain/workflows/execution_service.ts";
import { OWNER_STOP_GRACE_MS } from "../src/cli/commands/workflow_cancel.ts";
import { SHUTDOWN_ABORT_GRACE_MS } from "../src/serve/shutdown_drain.ts";
import { RUN_CANCEL_GRACE_MS } from "../src/serve/suspended_run_cancel.ts";

Deno.test("cancel graces: the step stop grace outlasts the shell kill grace", () => {
  // A shell step that ignores SIGTERM is killed, and saves its method run
  // cancelled, before the run stops waiting for it.
  assert(KILL_GRACE_MS < STEP_STOP_GRACE_MS);
});

Deno.test("cancel graces: serve still sees an aborted run finish within its step stop grace", () => {
  // Both serve timers start at the abort, as the run's wait does.
  assert(STEP_STOP_GRACE_MS < SHUTDOWN_ABORT_GRACE_MS);
  assert(STEP_STOP_GRACE_MS < RUN_CANCEL_GRACE_MS);
});

Deno.test("cancel graces: the step stop grace fits the owner-stop margin after one cleanup level", () => {
  // The margin cancel allows beyond one cleanup level's grace. Not a worst
  // case: several cleanup levels, or a nested run's wait, can already outlast
  // OWNER_STOP_GRACE_MS, and the canceller then settles the record the owner
  // left.
  const ownerStopMargin = OWNER_STOP_GRACE_MS - CLEANUP_GRACE_TIMEOUT_MS;
  assert(STEP_STOP_GRACE_MS < ownerStopMargin);
});
