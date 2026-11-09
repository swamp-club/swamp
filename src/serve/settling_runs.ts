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

import type { ActiveRun } from "./active_run_registry.ts";

/** past this a run still held is refused busy */
export const WINDING_DOWN_GRACE_MS = 5_000;

export async function awaitSettlingRuns(
  runs: ReadonlyArray<Pick<ActiveRun, "completion">>,
  options: { graceMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options;
  if (runs.length === 0 || signal?.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      Promise.allSettled(runs.map((run) => run.completion)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.graceMs ?? WINDING_DOWN_GRACE_MS);
        onAbort = () => resolve();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
