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
 * Runner entry point for the output-protection baseline (swamp-club#3512):
 * registers the fixture model, then runs one dispatch. Logging goes to
 * stderr at info, as the real `swamp worker exec-dispatch` runner's does, so
 * the supervisor sees what a runner writes there.
 */

import "../../src/domain/models/models.ts";
import "../remote_secrets_baseline_output_protection_model.ts";
import { initializeLogging } from "../../src/infrastructure/logging/logger.ts";
import { runDispatchRunner } from "../../src/worker/exec_dispatch.ts";

await initializeLogging({
  logLevel: "info",
  prettyOutput: false,
  noColor: true,
  stderrOnly: true,
});

await runDispatchRunner(Deno.stdin.readable, Deno.stdout.writable);
Deno.exit(0);
