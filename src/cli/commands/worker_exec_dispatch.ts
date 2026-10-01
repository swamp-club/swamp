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
 * `swamp worker exec-dispatch` — hidden entry point for the dispatch runner
 * child process. Executes exactly one dispatch received over stdin, with
 * all console and log output redirected to stderr. stdout is reserved for
 * length-prefixed RPC frames.
 */

import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { setProcessGroupIsolation } from "../../infrastructure/process/process_group_policy.ts";
import { runDispatchRunner } from "../../worker/exec_dispatch.ts";
import { redirectConsoleToStderr } from "../dispatch_runner_stdio.ts";

// Import models barrel so built-in models resolve from the runner's own
// registry when a `builtin:` bundle fingerprint is dispatched.
import "../../domain/models/models.ts";

export const workerExecDispatchCommand = new Command()
  .name("exec-dispatch")
  .description("Execute a single dispatch in a child process (internal)")
  .hidden()
  .action(async () => {
    // main.ts already redirected before tracing started; repeat it in case
    // this command is reached another way.
    redirectConsoleToStderr();
    // Dispatches are remote and stdio carries RPC frames, so a step's
    // prompts cannot be answered here: always let a cancel reach every
    // process the step started.
    setProcessGroupIsolation("always");

    await initializeLogging({
      logLevel: "info",
      prettyOutput: false,
      noColor: true,
      stderrOnly: true,
    });

    const stdin = Deno.stdin.readable;
    const stdout = Deno.stdout.writable;

    await runDispatchRunner(stdin, stdout);
  });
