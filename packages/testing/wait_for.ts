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

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * polls a condition until it holds instead of a fixed sleep, which races the
 * work it waits for; fails at the deadline with the caller's description of
 * what never happened.
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
