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

import "../src/domain/models/models.ts";
import { assert } from "@std/assert";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { v3WriterLeaseExpiresAt } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { DEFAULT_LOCK_TTL_MS } from "../src/infrastructure/persistence/file_lock.ts";
import {
  SERVE_WRITER_LEASE_TTL_MS,
  WRITER_LEASE_CLOCK_SKEW_MS,
} from "../src/domain/datastore_v3/writer_lease.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

// serve's first hold is the repo open at boot; the process's first hold
// decides the lease's TTL, so this is where serve's TTL must arrive
for (
  const [label, extra, ttlMs] of [
    [
      "serve's boot open",
      { v3LeaseTtlMs: SERVE_WRITER_LEASE_TTL_MS },
      SERVE_WRITER_LEASE_TTL_MS,
    ],
    ["a command's open", {}, DEFAULT_LOCK_TTL_MS],
  ] as const
) {
  Deno.test(`requireInitializedRepoUnlocked: ${label} takes a lease that lapses on its TTL plus the skew`, async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const before = Date.now();
      await requireInitializedRepoUnlocked({
        repoDir: repos.repoA,
        outputMode: "json",
        retakeLostV3Lease: true,
        ...extra,
      });
      const after = Date.now();
      try {
        const lapse = ttlMs + WRITER_LEASE_CLOCK_SKEW_MS;
        const expiresAt = await v3WriterLeaseExpiresAt(datastorePath);
        assert(
          expiresAt !== undefined && expiresAt >= before + lapse &&
            expiresAt <= after + lapse,
          `${expiresAt} within [${before + lapse}, ${after + lapse}]`,
        );
      } finally {
        await closeV3Datastores();
      }
    });
  });
}
