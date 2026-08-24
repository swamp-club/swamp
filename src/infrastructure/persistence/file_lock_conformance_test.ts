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
 * Runs the @swamp-club/swamp-testing lock conformance suite against
 * FileLock — the same DistributedLock contract extension datastore
 * authors are held to.
 */

import { assertLockConformance } from "@swamp-club/swamp-testing";
import { FileLock } from "./file_lock.ts";
import { initializeLogging } from "../logging/logger.ts";

await initializeLogging({});

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lock-conformance-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("FileLock: satisfies distributed lock conformance contract", async () => {
  await withTempDir(async (dir) => {
    // Short maxWaitMs so a contract violation fails fast instead of
    // spinning through the full default 60s acquisition budget.
    const lock = new FileLock(dir, { ttlMs: 5000, maxWaitMs: 2000 });
    await assertLockConformance(lock);
  });
});
