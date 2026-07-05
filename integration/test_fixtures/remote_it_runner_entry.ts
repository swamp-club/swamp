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
 * Runner entry point for integration tests — registers the test model
 * (swamp/remote-it) before starting the dispatch runner.
 */

import "../../src/domain/models/models.ts";
import "../remote_execution_test_model.ts";
import { initializeLogging } from "../../src/infrastructure/logging/logger.ts";
import { runDispatchRunner } from "../../src/worker/exec_dispatch.ts";

const encoder = new TextEncoder();
const write = (line: string) => {
  Deno.stderr.writeSync(encoder.encode(line + "\n"));
};
console.log = (...args: unknown[]) => write(args.map(String).join(" "));
console.info = (...args: unknown[]) => write(args.map(String).join(" "));
console.debug = (...args: unknown[]) => write(args.map(String).join(" "));
console.warn = (...args: unknown[]) =>
  write("[WARN] " + args.map(String).join(" "));
console.error = (...args: unknown[]) =>
  write("[ERROR] " + args.map(String).join(" "));

await initializeLogging({
  logLevel: "info",
  prettyOutput: false,
  noColor: true,
  stderrOnly: true,
});

await runDispatchRunner(Deno.stdin.readable, Deno.stdout.writable);
