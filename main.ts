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

// MUST be first: configures the TLS trust store before any other module is
// evaluated. Deno caches its root store on the first TLS handshake, which a
// heavy dependency (AWS SDK, OpenTelemetry, …) can trigger at import time —
// before main()'s body runs. See tls_trust_bootstrap.ts for the full rationale.
import "./src/infrastructure/runtime/tls_trust_bootstrap.ts";
import { runCli } from "./src/cli/mod.ts";
import { initializeLogging } from "./src/infrastructure/logging/logger.ts";
import { renderError } from "./src/presentation/output/error_output.ts";
import { flushDatastoreSync } from "./src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { getOutputModeFromArgs } from "./src/cli/context.ts";
import {
  initTracing,
  runWithParentTrace,
  shutdownTracing,
} from "./src/infrastructure/tracing/mod.ts";

if (import.meta.main) {
  const parentCtx = await initTracing();
  try {
    await runWithParentTrace(parentCtx, () => runCli(Deno.args));
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

  // Explicit exit so fire-and-forget promises (background update check,
  // telemetry cleanup) can never keep the event loop alive after the CLI
  // finishes. Telemetry flush is awaited inside runCli before reaching here.
  // The error path already calls Deno.exit(1) in the catch block above.
  Deno.exit(0);
}
