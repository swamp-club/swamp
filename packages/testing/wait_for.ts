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

/** Options for {@link waitFor}. */
export interface WaitForOptions {
  /** Give up and throw after this many milliseconds. Default: 10 000. */
  timeoutMs?: number;
  /** How often to re-check the condition. Default: 25. */
  intervalMs?: number;
}

/**
 * Polls a condition until it holds, instead of sleeping a fixed duration.
 *
 * A fixed `setTimeout` wait races the work it is waiting for: too short and
 * the test flakes under parallel CPU contention, too long and every run pays
 * the full delay. Polling waits exactly as long as needed and fails loudly
 * at the deadline with the caller's description of what never happened.
 *
 * ```typescript
 * import { waitFor } from "@swamp-club/swamp-testing";
 *
 * await service.start((e) => events.push(e));
 * await waitFor(() => events.length >= 1, "first schedule fire");
 * await service.stop();
 * ```
 *
 * @param condition - Re-checked every `intervalMs`; may be async. Truthy = done.
 * @param description - What is being waited for, used in the timeout error.
 * @throws Error when the deadline passes with the condition still false.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor: timed out after ${timeoutMs}ms waiting for ${description}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
