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

import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  bindRunProgress,
  registerRunProgress,
  removeRunProgress,
  runProgressSnapshots,
} from "../src/domain/remote/run_progress.ts";
import { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { reclaimModelLocks } from "../src/cli/repo_context.ts";

Deno.test("run progress: reclaim inspection remains visible until it answers", async () => {
  const dir = await Deno.makeTempDir();
  const progress = registerRunProgress({
    runId: crypto.randomUUID(),
    workflow: "workflow",
    job: "job",
    step: "step",
  });
  const lock = new FileLock(dir);
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<null>();
  async function* reclaim() {
    await reclaimModelLocks([lock], {
      inspect: () => {
        entered.resolve();
        return answer.promise;
      },
    });
    yield "reclaimed";
  }
  const stream = bindRunProgress(progress, reclaim());
  let pending: Promise<IteratorResult<string>> | undefined;
  try {
    await lock.acquire();
    pending = stream.next();
    await entered.promise;
    assertEquals(progress.snapshot().phase, "waiting_for_lock");
    assertEquals(progress.snapshot().resource, ".datastore.lock");
    assertEquals(progress.snapshot().holderKnown, false);
    answer.resolve(null);
    await pending;
    assertEquals(progress.snapshot().phase, "queued");
  } finally {
    answer.resolve(null);
    if (pending) await pending;
    await stream.return(undefined);
    await lock.release();
    removeRunProgress(progress);
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("run progress: identifies a blocked run and its local lock holder before completion", async () => {
  const dir = await Deno.makeTempDir();
  const holderId = crypto.randomUUID();
  const waiterId = crypto.randomUUID();
  const holderProgress = registerRunProgress({
    runId: holderId,
    workflow: "test",
    job: "job",
    step: "holder",
  });
  const waiterProgress = registerRunProgress({
    runId: waiterId,
    workflow: "test",
    job: "job",
    step: "waiter",
  });
  const holder = new FileLock(dir);
  const waiter = new FileLock(dir, { retryIntervalMs: 1, maxBackoffMs: 1 });
  async function* acquire(lock: FileLock) {
    await lock.acquire();
    yield "acquired";
  }
  const ownerStream = bindRunProgress(holderProgress, acquire(holder));
  const waitStream = bindRunProgress(waiterProgress, acquire(waiter));
  let pending: Promise<IteratorResult<string>> | undefined;
  try {
    await ownerStream.next();
    pending = waitStream.next();
    await waitFor(
      () => runProgressSnapshots(waiterId)[0]?.holderRunId === holderId,
      "waiting run names the observed lock holder",
    );
    const snapshot = runProgressSnapshots(waiterId)[0];
    assertEquals(snapshot.phase, "waiting_for_lock");
    assertEquals(snapshot.holderKnown, true);
    assert(snapshot.resource);
    assertEquals(
      await waiter.inspect().then((info) => info?.nonce),
      holder.heldNonce,
    );
    await holder.release();
    assertEquals((await pending).value, "acquired");
    assertEquals(runProgressSnapshots(waiterId)[0].phase, "queued");
  } finally {
    await holder.release();
    if (pending) await pending;
    await waiter.release();
    await ownerStream.return(undefined);
    await waitStream.return(undefined);
    removeRunProgress(holderProgress);
    removeRunProgress(waiterProgress);
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
