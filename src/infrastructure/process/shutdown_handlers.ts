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

/**
 * Cross-platform shutdown signal registration.
 *
 * Windows only supports `SIGINT` — registering `SIGTERM` or `SIGHUP`
 * listeners on Windows throws. This helper centralizes the OS branching so
 * each call site stays a single line and works on every platform that
 * swamp supports.
 *
 * On POSIX, `SIGINT`, `SIGTERM`, and `SIGHUP` are all registered (unless
 * the caller opts out of POSIX-only signals via `includePosixSignals: false`).
 * On Windows, only `SIGINT` is registered.
 */

/** Options passed to {@link registerShutdownHandler}. */
export interface ShutdownHandlerOptions {
  /**
   * Handler invoked once per signal arrival. Errors thrown synchronously
   * are not caught here; the caller is responsible for error handling
   * inside the handler.
   */
  handler: () => void | Promise<void>;
  /**
   * If true (default), also register `SIGTERM` and `SIGHUP` on POSIX
   * platforms. Set to false for sites that only ever cared about `SIGINT`
   * (e.g., the datastore sync coordinator's lock-release fast path).
   * Has no effect on Windows where only `SIGINT` is registered regardless.
   */
  includePosixSignals?: boolean;
}

/** Disposer returned by {@link registerShutdownHandler}. */
export interface ShutdownHandlerHandle {
  /**
   * Removes every signal listener that was registered. Idempotent —
   * safe to call multiple times.
   */
  dispose: () => void;
}

/**
 * POSIX-only signals registered when `includePosixSignals` is true.
 * Kept as a const tuple so callers see the exact set at a glance.
 */
const POSIX_ONLY_SIGNALS: readonly Deno.Signal[] = ["SIGTERM", "SIGHUP"];

/**
 * Registers a shutdown handler against the appropriate OS signals.
 *
 * - Always registers `SIGINT` (cross-platform).
 * - On non-Windows, also registers `SIGTERM` and `SIGHUP` unless
 *   `includePosixSignals` is explicitly false.
 *
 * Returns a disposer that calls `Deno.removeSignalListener` for every
 * signal that was actually registered.
 */
export function registerShutdownHandler(
  options: ShutdownHandlerOptions,
): ShutdownHandlerHandle {
  const { handler, includePosixSignals = true } = options;

  const registered: Deno.Signal[] = [];

  // SIGINT is always safe — both POSIX and Windows support it.
  Deno.addSignalListener("SIGINT", handler);
  registered.push("SIGINT");

  if (includePosixSignals && Deno.build.os !== "windows") {
    for (const signal of POSIX_ONLY_SIGNALS) {
      Deno.addSignalListener(signal, handler);
      registered.push(signal);
    }
  }

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const signal of registered) {
        try {
          Deno.removeSignalListener(signal, handler);
        } catch {
          // Listener may have already been removed (e.g. if Deno's
          // signal infrastructure tore it down). Best-effort cleanup.
        }
      }
    },
  };
}
