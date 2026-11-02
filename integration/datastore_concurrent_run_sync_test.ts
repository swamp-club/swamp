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
import { AsyncLocalStorage } from "node:async_hooks";
import { assertEquals, assertGreater, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import {
  type DatastoreSyncService,
  type PushManifest,
  UnpublishedDataVersionError,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  acquireModelLocks,
  PUBLISH_ATTEMPTS,
} from "../src/cli/repo_context.ts";
import { workflowStepLockHook } from "../src/cli/commands/workflow_run.ts";
import { createSyncGate, runSyncLanesOf } from "../src/serve/sync_gate.ts";
import {
  DATA_NAME,
  type Harness,
  withHarness,
  written,
} from "./concurrent_sync_harness.ts";

await initializeLogging({});

async function publishFirstVersion(h: Harness): Promise<void> {
  const locks = await h.lock();
  const version = await h.write("one");
  await locks.flush(written(h, version));
  assertEquals(h.remoteText("latest"), "1");
}

Deno.test("acquireModelLocks: a version whose marks a concurrent commit cleared is still published (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    const locks = await h.lock();
    const manifest = await h.other.preparePush();
    const version = await h.write("one");
    await h.other.commitPush(manifest);

    await locks.flush(written(h, version));

    assertEquals(h.remoteText("1/raw"), "one");
    assertEquals(h.remoteText("latest"), "1");
  });
});

Deno.test("acquireModelLocks: a latest marker a pull reverted before the push is moved forward again (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    await publishFirstVersion(h);

    const locks = await h.lock();
    const version = await h.write("two");
    // A peer commits, so the next pull takes the slow path, which downloads
    // every committed file whose bytes differ, the unpushed marker included.
    const peer = h.remote.connect(join(h.repoDir, "peer-cache"), {
      instance: "peer",
    });
    await peer.pullChanged();
    await Deno.mkdir(join(h.repoDir, "peer-cache", "other"), {
      recursive: true,
    });
    await Deno.writeTextFile(join(h.repoDir, "peer-cache", "other", "f"), "x");
    await peer.markDirty({ relPath: "other/f" });
    await peer.pushChanged();
    await h.other.pullChanged();
    assertEquals(await h.localLatest(), "1", "the pull reverted the marker");

    await locks.flush(written(h, version));

    assertEquals(await h.localLatest(), "2");
    assertEquals(h.remoteText("2/raw"), "two");
    assertEquals(h.remoteText("latest"), "2");
  });
});

Deno.test("acquireModelLocks: a push that lost its marks between staging and prepare is retried (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    const service = h.context.syncService!;
    const otherManifest = await h.other.preparePush();
    let interfered = 0;
    // Clears the dirty set right before the lock's first prepare, as a
    // concurrent commit landing between the re-mark and the walk would.
    const racing: DatastoreSyncService = {
      capabilities: () => service.capabilities!(),
      markDirty: (o) => service.markDirty(o),
      pullChanged: (o) => service.pullChanged(o),
      pushChanged: (o) => service.pushChanged(o),
      fetchContent: (p, o) => service.fetchContent!(p, o),
      preparePush: async (o) => {
        if (interfered++ === 0) await h.other.commitPush(otherManifest);
        return await service.preparePush!(o);
      },
      commitPush: (m, o) => service.commitPush!(m, o),
    };
    const locks = await h.lock(racing);
    const version = await h.write("one");

    await locks.flush(written(h, version));

    assertEquals(interfered, 2, "a second push round ran");
    assertEquals(h.remoteText("1/metadata.yaml") !== undefined, true);
    assertEquals(h.remoteText("latest"), "1");
  });
});

Deno.test("acquireModelLocks: a version deleted before the push is not published and fails nothing (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    const locks = await h.lock();
    const version = await h.write("one");
    await runInRootUnitOfWork(
      h.context.repoContext,
      { flush: undefined },
      () =>
        h.context.repoContext.unifiedDataRepo.delete(
          h.modelType,
          h.modelId,
          DATA_NAME,
        ),
    );

    await locks.flush(written(h, version));

    assertEquals(h.remoteText("1/raw"), undefined);
  });
});

Deno.test("acquireModelLocks: a version the remote never takes fails the push loudly after the bounded attempts (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    const service = h.context.syncService!;
    let prepares = 0;
    const losing: DatastoreSyncService = {
      capabilities: () => service.capabilities!(),
      markDirty: (o) => service.markDirty(o),
      pullChanged: (o) => service.pullChanged(o),
      pushChanged: (o) => service.pushChanged(o),
      fetchContent: (p, o) => service.fetchContent!(p, o),
      preparePush: () => {
        prepares++;
        return Promise.resolve(
          { uploads: new Map(), deletes: [] } as unknown as PushManifest,
        );
      },
      commitPush: () => Promise.resolve(0),
    };
    const locks = await h.lock(losing);
    const version = await h.write("one");

    const error = await assertRejects(
      () => locks.flush(written(h, version)),
      UnpublishedDataVersionError,
    );
    assertEquals(error.versions.map((v) => v.version), [1]);
    assertEquals(prepares, PUBLISH_ATTEMPTS);
  });
});

Deno.test("acquireModelLocks: a read-back that fails leaves a pushed version unverified instead of failing the push (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    const locks = await h.lock();
    const version = await h.write("one");
    h.remote.failNext("fetch", new Error("remote unreachable"));

    await locks.flush(written(h, version));

    assertEquals(h.remoteText("1/raw"), "one");
    assertEquals(h.remoteText("latest"), "1");
  });
});

Deno.test("acquireModelLocks: the last publish attempt asks to run alone (swamp-club#3146)", async () => {
  await withHarness(async (h) => {
    const service = h.context.syncService!;
    const losing: DatastoreSyncService = {
      capabilities: () => service.capabilities!(),
      markDirty: (o) => service.markDirty(o),
      pullChanged: (o) => service.pullChanged(o),
      pushChanged: (o) => service.pushChanged(o),
      fetchContent: (p, o) => service.fetchContent!(p, o),
      preparePush: () =>
        Promise.resolve(
          { uploads: new Map(), deletes: [] } as unknown as PushManifest,
        ),
      commitPush: () => Promise.resolve(0),
    };
    const kinds: string[] = [];
    const locks = await acquireModelLocks(
      h.context.datastoreConfig,
      [{ modelType: h.modelType.normalized, modelId: h.modelId }],
      h.repoDir,
      losing,
      h.context.repoContext.catalogStore,
      () => {},
      {
        repoContext: h.context.repoContext,
        wrapSync: (fn, kind) => {
          kinds.push(kind);
          return fn();
        },
      },
    );
    const version = await h.write("one");

    await assertRejects(
      () => locks.flush(written(h, version)),
      UnpublishedDataVersionError,
    );
    assertEquals(kinds, ["pull", "push", "push", "push-alone"]);
  });
});

interface Sibling {
  readonly parked: Promise<void>;
  readonly release: () => void;
  readonly done: Promise<void>;
}

Deno.test("workflowStepLockHook: the steps of one CLI run cannot undo a step's last publish attempt (swamp-club#3860)", async () => {
  await withHarness(async (h) => {
    const service = h.context.syncService!;
    const gate = createSyncGate();
    const lanes = runSyncLanesOf(gate);
    const queued = () => gate.waiters > 0 || lanes.waiters > 0;
    const siblingOf = new AsyncLocalStorage<{ park?: Sibling }>();
    let prepares = 0;
    let current: Sibling | undefined;

    // a sibling's commit clears every dirty mark, step A's staged ones too, so
    // step A's prepare walks a set holding only other paths
    const racing: DatastoreSyncService = {
      capabilities: () => service.capabilities!(),
      markDirty: (o) => service.markDirty(o),
      pullChanged: (o) => service.pullChanged(o),
      pushChanged: (o) => service.pushChanged(o),
      fetchContent: (p, o) => service.fetchContent!(p, o),
      preparePush: async (o) => {
        if (siblingOf.getStore() === undefined) {
          prepares++;
          const sibling = current!;
          sibling.release();
          await sibling.done;
          await h.write("another step", crypto.randomUUID());
          current = startSibling();
          let started = false;
          const reached = current.parked.then(() => {
            started = true;
          });
          // Under the gate a new sibling cannot start inside this push.
          await waitFor(() => started || queued(), "sibling parked or queued");
          if (started) await reached;
        }
        return await service.preparePush!(o);
      },
      commitPush: async (m, o) => {
        const state = siblingOf.getStore();
        const park = state?.park;
        if (park !== undefined) {
          state!.park = undefined;
          (park as Sibling & { reach: () => void }).reach();
          let released = false;
          const gateRelease = (park as Sibling & { gate: Promise<void> }).gate
            .then(() => {
              released = true;
            });
          await waitFor(() => released || queued(), "release or queued");
          if (released) await gateRelease;
        }
        return await service.commitPush!(m, o);
      },
    };
    const hook = workflowStepLockHook(
      h.repoDir,
      h.context.repoContext,
      h.context.datastoreConfig,
      racing,
      gate,
    );
    const startSibling = (): Sibling => {
      let reach!: () => void;
      let release!: () => void;
      const parked = new Promise<void>((r) => (reach = r));
      const gateOpen = new Promise<void>((r) => (release = r));
      const sibling = { parked, release, reach, gate: gateOpen } as
        & Sibling
        & { reach: () => void; gate: Promise<void> };
      const id = crypto.randomUUID();
      (sibling as { done: Promise<void> }).done = siblingOf.run(
        { park: sibling },
        async () => {
          const locks = await hook(h.modelType.normalized, id);
          const version = await h.write("sibling", id);
          await locks.flush([{
            modelType: h.modelType.normalized,
            modelId: id,
            dataName: DATA_NAME,
            version,
          }]);
        },
      );
      return sibling;
    };

    const locks = await hook(h.modelType.normalized, h.modelId);
    current = startSibling();
    await current.parked;
    const version = await h.write("step A");

    await locks.flush(written(h, version));
    current.release();
    await current.done;

    assertGreater(prepares, 1);
    assertEquals(h.remoteText("latest"), String(version));
    assertEquals(h.remoteText(`${version}/raw`), "step A");
  });
});
