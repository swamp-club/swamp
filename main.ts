// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { runCli } from "./src/cli/mod.ts";
import { initializeLogging } from "./src/infrastructure/logging/logger.ts";
import { renderError } from "./src/presentation/output/error_output.ts";
import { flushDatastoreSync } from "./src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { getOutputModeFromArgs } from "./src/cli/context.ts";
import {
  initTracing,
  shutdownTracing,
} from "./src/infrastructure/tracing/mod.ts";

if (import.meta.main) {
  await initTracing();
  try {
    await runCli(Deno.args);
  } catch (error) {
    // Release datastore lock if still held (safety net for uncaught errors)
    await flushDatastoreSync();
    const outputMode = getOutputModeFromArgs(Deno.args);
    await initializeLogging({
      jsonMode: outputMode === "json",
    });
    renderError(error, outputMode);
    Deno.exit(1);
  } finally {
    await shutdownTracing();
  }

  // Explicit exit so fire-and-forget promises (telemetry flush, background
  // update check) can never keep the event loop alive after the CLI finishes.
  // The error path already calls Deno.exit(1) in the catch block above.
  Deno.exit(0);
}
