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

// Model-based check of swamp-club#3146: two steps on two models of one
// repo, interleaved with another run's prepare and commit, a peer's commit
// and a pull, in any order, including inside a step's push (between its
// staging and its prepare). Whatever the schedule, every version a step
// wrote and still holds is on the remote once its lock's push returned,
// with a latest marker at least that version. A push fails, loudly, only
// when every one of its attempts was interfered with inside the push.

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import type { InMemoryPushManifest } from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import {
  type DatastoreSyncService,
  UnpublishedDataVersionError,
  type WrittenVersion,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  acquireModelLocks,
  type ModelLockResult,
  PUBLISH_ATTEMPTS,
} from "../src/cli/repo_context.ts";
import {
  DATA_NAME,
  type Harness,
  withHarness,
} from "./concurrent_sync_harness.ts";

await initializeLogging({});

/** Something another run or machine does, at a point in the schedule. */
type Interference =
  | "other-prepare" // another run of this process walks the dirty set
  | "other-commit" // ... and commits it, clearing every mark
  | "peer-pull" // a peer commits, then this cache pulls (slow path)
  // A commit clears the dirty set while the push walks it, cutting the walk
  // short after the latest markers (the extensions walk the live set).
  | "cut-walk";

/** One schedule entry: advance a step, or interfere now or in a push. */
type Op =
  | { kind: "advance"; step: 0 | 1 }
  | { kind: "now"; what: Interference }
  | { kind: "in-push"; what: Interference };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("advance" as const),
    step: fc.constantFrom(0 as const, 1 as const),
  }),
  fc.record({
    kind: fc.constant("now" as const),
    what: fc.constantFrom<Interference>(
      "other-prepare",
      "other-commit",
      "peer-pull",
    ),
  }),
  fc.record({
    kind: fc.constant("in-push" as const),
    what: fc.constantFrom<Interference>(
      "other-commit",
      "peer-pull",
      "cut-walk",
    ),
  }),
);

/** A step: take its model's lock, write versions, push. */
interface StepState {
  modelId: string;
  phase: "idle" | "locked" | "written" | "done";
  locks?: ModelLockResult;
  written: WrittenVersion[];
}

/** Per-run coverage of the interleavings, logged when the property ends. */
const coverage = new Map<string, number>();
const covered = (label: string) =>
  coverage.set(label, (coverage.get(label) ?? 0) + 1);

async function runSchedule(h: Harness, ops: readonly Op[]): Promise<void> {
  const steps: StepState[] = [
    { modelId: h.modelId, phase: "idle", written: [] },
    { modelId: crypto.randomUUID(), phase: "idle", written: [] },
  ];
  let otherManifest: InMemoryPushManifest | undefined;
  const pendingInPush: Interference[] = [];
  // Prepares that ran an interference first, and prepares overall.
  let interferedPrepares = 0;
  let prepares = 0;
  let peerWrites = 0;

  const service = h.context.syncService!;
  const interfere = async (what: Interference) => {
    if (what === "other-prepare") {
      otherManifest = await h.other.preparePush();
    } else if (what === "other-commit") {
      await h.other.commitPush(
        otherManifest ?? { uploads: new Map(), deletes: [] },
      );
      otherManifest = undefined;
    } else if (what === "cut-walk") {
      await h.other.commitPush({ uploads: new Map(), deletes: [] });
      for (const step of steps) {
        await service.markDirty({
          relPath:
            `data/${h.modelType.normalized}/${step.modelId}/${DATA_NAME}/latest`,
        });
      }
    } else {
      const peerCache = join(h.repoDir, "peer-cache");
      const peer = h.remote.connect(peerCache, { instance: "peer" });
      await Deno.mkdir(join(peerCache, "peer"), { recursive: true });
      await Deno.writeTextFile(
        join(peerCache, "peer", "f"),
        String(peerWrites++),
      );
      await peer.markDirty({ relPath: "peer/f" });
      await peer.pushChanged();
      await h.other.pullChanged();
    }
  };

  // Runs the interference scheduled for a push right before its prepare:
  // after the push staged its versions, before it walks the dirty set.
  const racing: DatastoreSyncService = {
    capabilities: () => service.capabilities!(),
    markDirty: (o) => service.markDirty(o),
    pullChanged: (o) => service.pullChanged(o),
    pushChanged: (o) => service.pushChanged(o),
    fetchContent: (p, o) => service.fetchContent!(p, o),
    preparePush: async (o) => {
      prepares++;
      const what = pendingInPush.shift();
      if (what !== undefined) {
        interferedPrepares++;
        covered(`in-push:${what}`);
        await interfere(what);
      }
      return await service.preparePush!(o);
    },
    commitPush: (m, o) => service.commitPush!(m, o),
  };

  const advance = async (step: StepState) => {
    if (step.phase === "idle") {
      step.locks = await acquireModelLocks(
        h.context.datastoreConfig,
        [{ modelType: h.modelType.normalized, modelId: step.modelId }],
        h.repoDir,
        racing,
        h.context.repoContext.catalogStore,
        () => {},
        { repoContext: h.context.repoContext },
      );
      step.phase = "locked";
    } else if (step.phase === "locked") {
      const version = await runInRootUnitOfWork(
        h.context.repoContext,
        { flush: undefined },
        async () =>
          (await h.context.repoContext.unifiedDataRepo.save(
            h.modelType,
            step.modelId,
            Data.create({
              name: DATA_NAME,
              contentType: "text/plain",
              lifetime: "infinite",
              garbageCollection: 100,
              tags: { type: "test" },
              ownerDefinition: { ownerType: "manual", ownerRef: "test" },
            }),
            new TextEncoder().encode(crypto.randomUUID()),
          )).version,
      );
      step.written.push({
        modelType: h.modelType.normalized,
        modelId: step.modelId,
        dataName: DATA_NAME,
        version,
      });
      step.phase = "written";
    } else if (step.phase === "written") {
      if (pendingInPush.length > 0) covered("push-with-interference");
      const preparesBefore = prepares;
      const interferedBefore = interferedPrepares;
      try {
        await step.locks!.flush(step.written);
        assertPublished(h, step);
      } catch (error) {
        // Failing loudly is allowed only when every attempt of this push
        // had its marks cleared or its marker reverted inside the push.
        if (!(error instanceof UnpublishedDataVersionError)) throw error;
        assertEquals(prepares - preparesBefore, PUBLISH_ATTEMPTS);
        assertEquals(interferedPrepares - interferedBefore, PUBLISH_ATTEMPTS);
        covered("loud-failure");
      }
      step.phase = "done";
    }
  };

  for (const op of ops) {
    if (op.kind === "advance") {
      covered(`advance:${steps[op.step].phase}`);
      await advance(steps[op.step]);
    } else if (op.kind === "now") {
      covered(`now:${op.what}`);
      await interfere(op.what);
    } else {
      pendingInPush.push(op.what);
    }
  }
  // Quiescence: finish every step.
  for (const step of steps) {
    while (step.phase !== "done") await advance(step);
  }
}

/** The step's last version is on the remote, and so is a marker naming it. */
function assertPublished(h: Harness, step: StepState): void {
  const last = step.written.at(-1)!;
  const dir = `data/${h.modelType.normalized}/${step.modelId}/${DATA_NAME}`;
  const files = h.remote.files();
  assert(
    files.has(`${dir}/${last.version}/metadata.yaml`),
    `version ${last.version} of ${step.modelId} is not on the remote`,
  );
  const latest = files.get(`${dir}/latest`);
  assert(latest !== undefined, "no latest marker on the remote");
  const remoteLatest = parseInt(new TextDecoder().decode(latest), 10);
  assert(
    remoteLatest >= last.version,
    `remote latest ${remoteLatest} is behind ${last.version}`,
  );
}

Deno.test("acquireModelLocks: any interleaving of runs, pulls and commits leaves every written version published (swamp-club#3146)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { maxLength: 14 }), async (ops) => {
      await withHarness((h) => runSchedule(h, ops));
    }),
    { numRuns: 150 },
  );
  // Every interleaving the property is about must have been generated.
  for (
    const label of [
      "now:other-prepare",
      "now:other-commit",
      "now:peer-pull",
      "in-push:other-commit",
      "in-push:peer-pull",
      "in-push:cut-walk",
      "advance:written",
    ]
  ) {
    assert((coverage.get(label) ?? 0) > 0, `never generated ${label}`);
  }
  console.log(
    "coverage:",
    JSON.stringify(Object.fromEntries([...coverage].sort())),
  );
});
