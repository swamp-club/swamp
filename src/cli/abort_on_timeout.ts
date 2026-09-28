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
 * Aborts `controller` once `ms` elapse, with the same `TimeoutError` reason
 * `AbortSignal.timeout` gives, so a local run cancelled by `--timeout`
 * records a timeout as its `cancel_reason` rather than a bare abort
 * indistinguishable from Ctrl-C. Over `--server` the reason stays with the
 * client: the cancel frame sent to serve carries none. A controller that is
 * already aborted keeps its own reason.
 *
 * Returns a disposer that disarms the timeout. Call it once the guarded work
 * ends: while its abort listener is attached, the timeout keeps the process
 * alive.
 */
export function abortOnTimeout(
  controller: AbortController,
  ms: number,
): () => void {
  const timeout = AbortSignal.timeout(ms);
  const onTimeout = () => controller.abort(timeout.reason);
  timeout.addEventListener("abort", onTimeout, { once: true });
  return () => timeout.removeEventListener("abort", onTimeout);
}
