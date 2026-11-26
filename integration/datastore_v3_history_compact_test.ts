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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { LOCK_TIMEOUT_ENV_VAR } from "../src/domain/datastore/datastore_config.ts";
import {
  modelCommit,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { V3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  compactV3HistoryNow,
  holdV3Writer,
  v3DatastoreConfigOf,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  V3WriterBusyError,
  type V3WriterLockRelease,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { startProcessHost } from "./process_host.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

/** past the policy's floor: 600 commits below the newest 2,500 */
const COMMITS = 3_100;

async function seed(handle: V3Datastore, count: number): Promise<void> {
  const fence = handle.commitStore.writerFence();
  const appends: Promise<unknown>[] = [];
  for (let seq = 1; seq <= count; seq++) {
    appends.push(handle.commitStore.append(
      modelCommit(seq, [versionOp("seeded", seq)], {
        txnId: crypto.randomUUID(),
        at: "2020-01-01T00:00:00.000Z",
        ...(fence === undefined ? {} : { fence }),
      }),
    ));
  }
  await Promise.all(appends);
}

type LeaseRequest = { kind: "hold"; datastorePath: string } | {
  kind: "release";
};
type LeaseMessage = { held: true } | { released: true } | { failed: string };

/** another swamp process, holding the datastore's writer lease until told */
function leaseHolder(
  post: (message: LeaseMessage) => void,
): (request: LeaseRequest) => void {
  let release: V3WriterLockRelease | undefined;
  return (request) => {
    const work = request.kind === "hold"
      ? acquireV3WriterLock(request.datastorePath, { maxWaitMs: 30_000 })
        .then((r) => {
          release = r;
          post({ held: true });
        })
      : (release?.() ?? Promise.resolve()).then(() => post({ released: true }));
    work.catch((error) => post({ failed: String(error) }));
  };
}

Deno.test({
  name:
    "datastore compact --history: a local v3 writer folds the history past the policy's floor, and a second run finds nothing due",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos) => {
      await closeV3Datastores();
      try {
        const location = await v3DatastoreConfigOf(
          repos.repoA,
          repos.a.datastoreConfig,
        );
        await holdV3Writer(location, repos.repoA);
        const handle = v3DatastoreFor(repos.repoA, location);
        await seed(handle, COMMITS);
        const stored = (await handle.describe()).storedCommits;
        assert(stored >= COMMITS, `seeded ${stored} commits`);

        const first = await compactV3HistoryNow(repos.repoA, location);
        assert(first.outcome === "compacted", JSON.stringify(first));
        assertEquals(first.compacted, stored - 2_500);
        assertEquals(
          (await handle.describe()).compactedThrough,
          first.compactedThrough,
        );
        assertEquals((await handle.describe()).storedCommits, 2_500);

        assertEquals(await compactV3HistoryNow(repos.repoA, location), {
          outcome: "not_due",
          eligibleCommits: 0,
          minCommits: 500,
          retainCommits: 2_500,
        });
      } finally {
        await closeV3Datastores();
      }
    });
  },
});

Deno.test({
  name:
    "datastore compact --history: while another process holds the writer lease, the run fails on the lease and folds nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const messages: LeaseMessage[] = [];
      const other = startProcessHost<LeaseRequest, LeaseMessage>(
        "lease-holder",
        leaseHolder,
        (message) => messages.push(message),
      );
      try {
        const location = await v3DatastoreConfigOf(
          repos.repoA,
          repos.a.datastoreConfig,
        );
        await holdV3Writer(location, repos.repoA);
        const handle = v3DatastoreFor(repos.repoA, location);
        const before = (await handle.describe()).compactedThrough;

        other.postMessage({ kind: "hold", datastorePath });
        await waitFor(
          () => messages.some((m) => "held" in m || "failed" in m),
          "the other process holds the lease",
          { timeoutMs: 60_000 },
        );
        assertEquals(messages.find((m) => "failed" in m), undefined);

        await withMockedEnv({ [LOCK_TIMEOUT_ENV_VAR]: "200" }, async () => {
          await assertRejects(
            () => compactV3HistoryNow(repos.repoA, location),
            V3WriterBusyError,
          );
        });
        assertEquals((await handle.describe()).compactedThrough, before);

        other.postMessage({ kind: "release" });
        await waitFor(
          () => messages.some((m) => "released" in m),
          "the other process lets go of the lease",
          { timeoutMs: 60_000 },
        );
      } finally {
        other.terminate();
        await closeV3Datastores();
      }
    });
  },
});
