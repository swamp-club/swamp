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

// must be first: Deno caches its root TLS store on the first handshake, which a
// heavy dependency can trigger at import time
import "./src/infrastructure/runtime/tls_trust_bootstrap.ts";
import { runCli } from "./src/cli/mod.ts";
import { initializeLogging } from "./src/infrastructure/logging/logger.ts";
import {
  exitCodeForError,
  renderError,
} from "./src/presentation/output/error_output.ts";
import { flushDatastoreSync } from "./src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { getOutputModeFromArgs } from "./src/cli/context.ts";
import {
  initTracing,
  runWithParentTrace,
  shutdownLogs,
  shutdownTracing,
} from "./src/infrastructure/tracing/mod.ts";
import { VERSION } from "./src/cli/commands/version.ts";
import {
  initExecutionMetrics,
  shutdownExecutionMetrics,
} from "./src/infrastructure/tracing/otel_metrics_init.ts";
import { commandSurfaceFromArgs } from "./src/cli/command_surface_args.ts";
import {
  isDispatchRunnerInvocation,
  redirectConsoleToStderr,
} from "./src/cli/dispatch_runner_stdio.ts";
import {
  isSupervisorInvocation,
  runSupervisorMain,
} from "./src/infrastructure/datastore_v3/litestream/replication_supervisor_entry.ts";
import {
  isBundleProbeHostInvocation,
  runBundleProbeHost,
} from "./src/infrastructure/runtime/bundle_probe_host.ts";

if (import.meta.main) {
  if (isSupervisorInvocation(Deno.args)) {
    Deno.exit(await runSupervisorMain(Deno.args));
  }
  // a probe host reads the parent's SWAMP_BUILD_VERSION, so it runs before that
  // is set below
  if (isBundleProbeHostInvocation(Deno.args)) {
    Deno.exit(await runBundleProbeHost(VERSION));
  }
  Deno.env.set("SWAMP_BUILD_VERSION", VERSION);
  // The dispatch runner's stdout is an RPC frame stream; nothing, including
  // a console span exporter, may print there.
  if (isDispatchRunnerInvocation(Deno.args)) redirectConsoleToStderr();
  const parentCtx = await initTracing();
  await initExecutionMetrics();
  // Set on the error path; the exit waits until telemetry has drained, so a
  // failing command's spans and logs — its swamp.cli root included — are not
  // cut off by Deno.exit.
  let errorExitCode: number | undefined;
  try {
    await runWithParentTrace(parentCtx, () => runCli(Deno.args));
  } catch (error) {
    await flushDatastoreSync();
    const outputMode = getOutputModeFromArgs(Deno.args);
    await initializeLogging({
      jsonMode: outputMode === "json",
    });
    renderError(error, outputMode, commandSurfaceFromArgs(Deno.args));
    errorExitCode = exitCodeForError(error);
  } finally {
    // Drain the OTLP logs signal before spans — shutdownLogs() awaits the
    // exporter's in-flight sends so the last log records aren't cut by
    // Deno.exit. Both are no-ops when their signal was never initialized.
    await shutdownLogs();
    await shutdownTracing();
    await shutdownExecutionMetrics();
  }

  // explicit exit so background promises cannot keep the event loop alive; no
  // arg honors Deno.exitCode set by commands, so never pass 0, which overwrites
  // a failure code
  Deno.exit(errorExitCode);
}
