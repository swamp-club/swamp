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
 * Serve's pollers against a real catalog, a real policy loader and a peer
 * (swamp-club#2863). Repo A is the serve side S: its shared sync service and
 * its `repoContext.catalogStore`, plus, in scenario 6, one sync gate shared
 * by the poller and S's gated requests. Repo B is the peer P, writing into
 * its own cache and pushing to the same in-memory remote. Each poller is
 * wired as `src/cli/commands/serve.ts` wires it (`catalogInvalidate` runs
 * `repoContext.catalogStore.invalidate()`), and each scenario checks what
 * S's `DataQueryService`, definition repository or `PolicySnapshotLoader`
 * return after one poll cycle. The later serve-leader phase replaces these pollers
 * with a commit feed and has to match this behaviour. The end-to-end
 * counterpart is swamp-uat#491.
 *
 * A poller only exposes `start()`/`stop()` on an interval, so "one cycle"
 * is a short interval, `waitFor` on the pulls the sync wrapper saw finish,
 * then `stop()`, which waits for the cycle's invalidation and policy reload.
 *
 * Today's behaviour is pinned, gaps included: an observation that differs
 * from what a user would expect must equal today's outcome and have its key
 * in {@link PINNED_GAPS}, so a fix forces this file to change on purpose.
 *
 * Drift from the issue text: a peer's delete is not visible after one poll,
 * because the pull leaves removals out of its count (swamp-club#2892) and an
 * invalidated catalog never removes rows (ADDITIVE BACKFILL, see
 * `integration/datastore_peer_propagation_test.ts`). Scenario 2 pins it.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, equal } from "@std/assert";
import { relative } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import type { DataRecord } from "../src/domain/data/data_record.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../src/domain/datastore/datastore_sync_service.ts";
import type {
  AccessPrincipal,
  AccessResource,
} from "../src/domain/access/access_decision_service.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
} from "../src/domain/models/access/grant_model.ts";
import { computeFileContentHashIfExists } from "../src/domain/extensions/extension_package_cache.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { ReadWriteLock } from "../src/infrastructure/stream/read_write_lock.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { AccessDataPoller } from "../src/serve/access_data_poller.ts";
import { ConfigPoller } from "../src/serve/config_poller.ts";
import type { ExtensionReloadResult } from "../src/serve/extension_reload.ts";
import { RuntimeDataPoller } from "../src/serve/runtime_data_poller.ts";
import { POLLER_ESCALATE_AFTER_SKIPS } from "../src/serve/sync_gate.ts";
import { ActiveRunRegistry } from "../src/serve/active_run_registry.ts";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";
import {
  createServeCtx,
  saveData,
  saveModel,
} from "./serve_request_harness.ts";
import {
  cacheDir,
  type RowRepos,
  runServe,
  settle,
  type UnlockedRepo,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

/**
 * Today's gaps, one key per observation that differs from what a user would
 * expect. Keys start with the scenario number. The causes:
 *
 * - UNCOUNTED REMOVAL (swamp-club#2892): a pull removes the local copy of a
 *   file a peer deleted but leaves it out of its count, so a delete-only
 *   pull returns 0 and RuntimeDataPoller does not invalidate. S's populated
 *   catalog keeps listing the row; an invalidation would not remove it
 *   either (ADDITIVE BACKFILL: backfill only upserts).
 * - VOID AS ZERO: AccessDataPoller and RuntimeDataPoller read a void pull
 *   result as 0 (access_data_poller.ts, runtime_data_poller.ts `typeof
 *   result === "number" ? result : 0`), while ConfigPoller and the sync
 *   contract read it as "changed, count unknown". After a void pull the
 *   pulled files are on disk but S neither invalidates nor reloads policy.
 */
const PINNED_GAPS: readonly string[] = [
  // UNCOUNTED REMOVAL (swamp-club#2892).
  "s2 delete: the poller does not invalidate after a delete-only pull",
  "s2 delete: S's query still lists the row P deleted",
  "s2 delete: S's latest lookup still returns the row P deleted",
  // VOID AS ZERO.
  "s5 void: RuntimeDataPoller does not invalidate",
  "s5 void: S's query misses P's row",
  "s5 void: AccessDataPoller does not invalidate",
  "s5 void: S's policy still denies P's grant",
];

function expectOrGap<T>(
  gaps: string[],
  key: string,
  actual: T,
  expected: T,
  today: T,
): void {
  if (equal(actual, expected)) return;
  assertEquals(
    actual,
    today,
    `${key}: neither the expected outcome nor today's pinned one`,
  );
  gaps.push(key);
}

function assertGaps(gaps: string[], scenario: string): void {
  assertPinnedSet(
    [...new Set(gaps)].sort(),
    PINNED_GAPS.filter((key) => key.startsWith(`${scenario} `)).sort(),
    `serve poller gaps (${scenario})`,
    "A new divergence from the expected outcome: fix it, or pin it in " +
      "PINNED_GAPS with a comment naming the gap.",
  );
}

const POLL_INTERVAL_MS = 20;
const PEER_MODEL = "peer-model";
const PEER_MODEL_ID = crypto.randomUUID();

/**
 * S's sync service as the pollers and handlers see it: every call reaches
 * the real service, the pulls that finished are counted, a pull can report
 * a void count, and any pull that overlaps a push (single- or two-phase) is
 * recorded.
 */
interface CountingSyncService extends DatastoreSyncService {
  pullsCompleted: number;
  voidPulls: boolean;
  readonly overlaps: string[];
}

function countingSyncService(
  inner: DatastoreSyncService,
): CountingSyncService {
  let pullsInFlight = 0;
  let pushesInFlight = 0;
  const pushing = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ) =>
  async (...args: A): Promise<R> => {
    if (pullsInFlight > 0) service.overlaps.push("push during pull");
    pushesInFlight++;
    try {
      return await fn(...args);
    } finally {
      pushesInFlight--;
    }
  };
  const service: CountingSyncService = {
    pullsCompleted: 0,
    voidPulls: false,
    overlaps: [],
    async pullChanged(options) {
      if (pushesInFlight > 0) service.overlaps.push("pull during push");
      pullsInFlight++;
      try {
        const result = await inner.pullChanged(options);
        return service.voidPulls ? undefined : result;
      } finally {
        pullsInFlight--;
        service.pullsCompleted++;
      }
    },
    pushChanged: pushing((options?: DatastoreSyncOptions) =>
      inner.pushChanged(options)
    ),
    markDirty: (options) => inner.markDirty(options),
  };
  if (inner.capabilities) service.capabilities = () => inner.capabilities!();
  if (inner.preparePush) {
    const prepare = inner.preparePush.bind(inner);
    service.preparePush = pushing(prepare);
  }
  if (inner.commitPush) {
    const commit = inner.commitPush.bind(inner);
    service.commitPush = pushing(commit);
  }
  if (inner.fetchContent) service.fetchContent = inner.fetchContent.bind(inner);
  if (inner.hydrateFile) service.hydrateFile = inner.hydrateFile.bind(inner);
  return service;
}

/** S: repo A's context, its wrapped sync service and an invalidation count. */
interface Serve {
  repos: RowRepos;
  ctx: UnlockedRepo;
  sync: CountingSyncService;
  invalidations: { count: number };
  catalogInvalidate: () => void;
}

function serveSide(repos: RowRepos): Serve {
  const ctx = repos.a;
  const invalidations = { count: 0 };
  return {
    repos,
    ctx,
    sync: countingSyncService(ctx.syncService!),
    invalidations,
    catalogInvalidate: () => {
      invalidations.count++;
      ctx.repoContext.catalogStore.invalidate();
    },
  };
}

interface Poller {
  start(): void;
  stop(): Promise<void>;
}

/**
 * Starts `poller`, waits until `cycles` more pulls finished, and stops it,
 * which waits for the cycle's invalidation and any policy reload.
 */
async function runCycles(
  poller: Poller,
  sync: CountingSyncService,
  cycles = 1,
): Promise<void> {
  const target = sync.pullsCompleted + cycles;
  poller.start();
  try {
    await waitFor(
      () => sync.pullsCompleted >= target,
      `${cycles} poll cycle(s)`,
    );
  } finally {
    await poller.stop();
  }
}

/**
 * Opens P (repo B), runs `fn`, pushes what it marked through B's own sync
 * service, as a peer serve's handler does, and closes its catalog.
 */
async function onPeer(
  repos: RowRepos,
  fn: (peer: UnlockedRepo) => Promise<void>,
): Promise<void> {
  const peer = await requireInitializedRepoUnlocked({
    repoDir: repos.repoB,
    outputMode: "json",
  });
  try {
    await fn(peer);
    await flushDatastoreSync();
    await peer.syncService!.pushChanged();
  } finally {
    peer.repoContext.catalogStore.close();
  }
}

function peerData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: PEER_MODEL },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

async function peerSave(
  repos: RowRepos,
  peer: UnlockedRepo,
  name: string,
): Promise<void> {
  await peer.repoContext.unifiedDataRepo.save(
    repos.modelType,
    PEER_MODEL_ID,
    peerData(name),
    new TextEncoder().encode(JSON.stringify({ from: "peer" })),
  );
}

/** What S's catalog returns for the peer's model, as `name@version`. */
async function serveView(
  s: Serve,
  name: string,
): Promise<{ latest: string | null; query: string[] }> {
  const { dataQueryService } = s.ctx.repoContext;
  const record = await dataQueryService.getLatestRecord(PEER_MODEL, name);
  const rows = await dataQueryService.query(
    `modelName == "${PEER_MODEL}"`,
  ) as DataRecord[];
  return {
    latest: record ? `${record.name}@${record.version}` : null,
    query: rows.map((r) => `${r.name}@${r.version}`).sort(),
  };
}

function remotePeerKeys(repos: RowRepos): string[] {
  return [...repos.remote.files().keys()]
    .filter((key) => key.includes(`/${PEER_MODEL_ID}/`))
    .sort();
}

function runtimePoller(s: Serve, gate?: ReadWriteLock): RuntimeDataPoller {
  return new RuntimeDataPoller({
    syncService: s.sync,
    syncGate: gate,
    catalogInvalidate: s.catalogInvalidate,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

// ---------------------------------------------------------------------------
// Scenarios 1 and 2: runtime data

Deno.test("RuntimeDataPoller: s1 a peer's write becomes visible to S's queries after one poll", async () => {
  await withRowRepos({}, async (repos) => {
    const s = serveSide(repos);
    // S's catalog is populated before P writes.
    assertEquals(await serveView(s, "x"), { latest: null, query: [] });

    await onPeer(repos, (peer) => peerSave(repos, peer, "x"));
    assert(remotePeerKeys(repos).length > 0, "P's push reached the remote");
    // Negative control: nothing on S changes until a poll pulls.
    assertEquals(await serveView(s, "x"), { latest: null, query: [] });

    await runCycles(runtimePoller(s), s.sync);
    assertEquals(s.invalidations.count, 1);
    assertEquals(await serveView(s, "x"), { latest: "x@1", query: ["x@1"] });
  });
});

Deno.test("RuntimeDataPoller: s2 a peer's delete after one poll, and a gated handler push does not bring it back", async () => {
  const gaps: string[] = [];
  await withRowRepos({}, async (repos) => {
    const s = serveSide(repos);
    // S's own model, which the handler write below renames.
    const own = await saveModel(repos.serveRepo, "m1");
    await saveData(repos.serveRepo, own, "state");
    await onPeer(repos, (peer) => peerSave(repos, peer, "x"));
    await settle(repos);
    await runCycles(runtimePoller(s), s.sync);
    assertEquals(await serveView(s, "x"), { latest: "x@1", query: ["x@1"] });
    const invalidationsBefore = s.invalidations.count;

    await onPeer(
      repos,
      (peer) =>
        peer.repoContext.unifiedDataRepo.delete(
          repos.modelType,
          PEER_MODEL_ID,
          "x",
        ),
    );
    assertEquals(remotePeerKeys(repos), [], "P's delete reached the remote");

    await runCycles(runtimePoller(s), s.sync);
    expectOrGap(
      gaps,
      "s2 delete: the poller does not invalidate after a delete-only pull",
      s.invalidations.count - invalidationsBefore,
      1,
      0,
    );
    const view = await serveView(s, "x");
    expectOrGap(
      gaps,
      "s2 delete: S's query still lists the row P deleted",
      view.query,
      [],
      ["x@1"],
    );
    expectOrGap(
      gaps,
      "s2 delete: S's latest lookup still returns the row P deleted",
      view.latest,
      null,
      "x@1",
    );
    // The pull did remove S's copy (swamp-club#2999): only the catalog lags.
    assertEquals(
      await repos.a.repoContext.unifiedDataRepo.findByName(
        repos.modelType,
        PEER_MODEL_ID,
        "x",
      ),
      null,
    );

    // A gated handler write on S, then its push (swamp-club#2247): the
    // deleted item stays off the remote and P never sees it again.
    const ctx = createServeCtx(repos.serveRepo, undefined, {
      syncService: s.sync,
      syncGate: new ReadWriteLock(),
      activeRunRegistry: new ActiveRunRegistry(),
      vaultsDir: repos.a.vaultsDir,
    });
    await runServe(ctx, {
      type: "data.rename",
      payload: { modelIdOrName: "m1", oldName: "state", newName: "renamed" },
    });
    assertEquals(remotePeerKeys(repos), []);
    await onPeer(repos, async (peer) => {
      await peer.syncService!.pullChanged();
      assertEquals(
        await peer.repoContext.unifiedDataRepo.findByName(
          repos.modelType,
          PEER_MODEL_ID,
          "x",
        ),
        null,
      );
    });
  });
  assertGaps(gaps, "s2");
});

// ---------------------------------------------------------------------------
// Scenario 3: access

const GRANTEE: AccessPrincipal = {
  principal: { kind: "user", id: "peer-grantee" },
  collectives: [],
  groups: [],
};
const GRANTED_RESOURCE: AccessResource = {
  kind: "model",
  name: "granted-model",
  fields: {},
};
const GRANT_MODEL_ID = crypto.randomUUID();

function peerGrant(id: string, state: Grant["state"]): Grant {
  return {
    id,
    subject: { kind: "user", name: GRANTEE.principal.id },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "model", pattern: GRANTED_RESOURCE.name },
    state,
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

async function peerSaveGrant(peer: UnlockedRepo, grant: Grant): Promise<void> {
  await peer.repoContext.unifiedDataRepo.save(
    GRANT_MODEL_TYPE,
    GRANT_MODEL_ID,
    Data.create({
      name: "grant-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: "peer-grant" },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${GRANT_MODEL_TYPE.normalized}:${GRANT_MODEL_ID}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify(grant)),
  );
}

function policyLoader(s: Serve): PolicySnapshotLoader {
  // Manual mode: only the poller reloads. A peer's write never reaches S's
  // event bus, so auto mode would not reload on it either.
  return new PolicySnapshotLoader(
    s.ctx.repoContext.unifiedDataRepo,
    s.ctx.repoContext.eventBus,
    "manual",
    { runImpliesApprove: true, runImpliesSignal: true },
  );
}

function accessPoller(
  s: Serve,
  loader: PolicySnapshotLoader,
): AccessDataPoller {
  return new AccessDataPoller({
    syncService: s.sync,
    policySnapshotLoader: loader,
    catalogInvalidate: s.catalogInvalidate,
    pollIntervalMs: POLL_INTERVAL_MS,
  });
}

function decision(loader: PolicySnapshotLoader): string {
  return loader.decisionService.decide(GRANTEE, "read", GRANTED_RESOURCE)
    ?.effect ?? "deny";
}

Deno.test("AccessDataPoller: s3 a peer's grant and its revocation reach S's policy after one poll each", async () => {
  await withRowRepos({}, async (repos) => {
    const s = serveSide(repos);
    const loader = policyLoader(s);
    try {
      await loader.load();
      const grantId = crypto.randomUUID();

      await onPeer(
        repos,
        (peer) => peerSaveGrant(peer, peerGrant(grantId, "active")),
      );
      // Negative control: S's policy is unchanged until a poll.
      assertEquals(decision(loader), "deny");
      await runCycles(accessPoller(s, loader), s.sync);
      assertEquals(s.invalidations.count, 1);
      assertEquals(decision(loader), "allow");

      await onPeer(
        repos,
        (peer) => peerSaveGrant(peer, peerGrant(grantId, "revoked")),
      );
      assertEquals(decision(loader), "allow");
      await runCycles(accessPoller(s, loader), s.sync);
      assertEquals(s.invalidations.count, 2);
      assertEquals(decision(loader), "deny");
    } finally {
      await loader.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: config

const RELOAD_OK: ExtensionReloadResult = { status: "ok", errors: [] };

Deno.test("ConfigPoller: s4 a peer's definition and lockfile changes reach S after one poll each", async () => {
  await withRowRepos({ managedConfig: true }, async (repos) => {
    const s = serveSide(repos);
    // The lockfile path serve watches (serve.ts takes it from
    // requireInitializedRepoUnlocked as managedLockfilePath).
    const lockfilePath = s.ctx.lockfilePath;
    let reloads = 0;
    const poller = (bootHash: string | null) =>
      new ConfigPoller({
        syncService: s.sync,
        catalogInvalidate: s.catalogInvalidate,
        extensionReloader: () => {
          reloads++;
          return Promise.resolve(RELOAD_OK);
        },
        lockfileHash: () => computeFileContentHashIfExists(lockfilePath),
        baselineLockfileHash: bootHash,
        pollIntervalMs: POLL_INTERVAL_MS,
      });

    const definition = Definition.create({ name: "peer-def" });
    const findOnServe = async () =>
      (await s.ctx.repoContext.definitionRepo.findById(
        repos.modelType,
        definition.id,
      ))?.name ?? null;

    await onPeer(
      repos,
      (peer) =>
        peer.repoContext.definitionRepo.save(repos.modelType, definition),
    );
    assertEquals(await findOnServe(), null);
    const bootHash = await computeFileContentHashIfExists(lockfilePath);
    await runCycles(poller(bootHash), s.sync);
    assertEquals(s.invalidations.count, 1);
    assertEquals(await findOnServe(), "peer-def");
    assertEquals(reloads, 0, "an unchanged lockfile reloads nothing");

    // P changes the managed lockfile in its config tier and pushes it.
    await onPeer(repos, async (peer) => {
      await Deno.writeTextFile(
        peer.lockfilePath,
        JSON.stringify({ "@peer/ext": { version: "2026.01.01.1" } }),
      );
      await peer.syncService!.markDirty({
        relPath: relative(cacheDir(repos.repoB), peer.lockfilePath)
          .replaceAll("\\", "/"),
      });
    });
    assertEquals(
      await computeFileContentHashIfExists(lockfilePath),
      bootHash,
      "S has not pulled the lockfile yet",
    );
    await runCycles(poller(bootHash), s.sync);
    assertEquals(reloads, 1, "the pulled lockfile change reloads once");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: void pull results

Deno.test("pollers: s5 a void pull result invalidates in ConfigPoller only", async () => {
  const gaps: string[] = [];
  await withRowRepos({}, async (repos) => {
    const s = serveSide(repos);
    s.sync.voidPulls = true;
    assertEquals(await serveView(s, "x"), { latest: null, query: [] });

    const pullsBefore = s.sync.pullsCompleted;
    const config = new ConfigPoller({
      syncService: s.sync,
      catalogInvalidate: s.catalogInvalidate,
      extensionReloader: () => Promise.resolve(RELOAD_OK),
      lockfileHash: () => Promise.resolve(null),
      baselineLockfileHash: null,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    await runCycles(config, s.sync);
    // Unknown count reads as changed (config_poller.ts): every void pull
    // invalidates. A second cycle can start before stop(), so compare with
    // the pulls that ran rather than with 1.
    const configPulls = s.sync.pullsCompleted - pullsBefore;
    assert(configPulls >= 1);
    assertEquals(s.invalidations.count, configPulls);
    s.invalidations.count = 0;
    // Repopulate S's catalog so the runtime check starts populated.
    assertEquals(await serveView(s, "x"), { latest: null, query: [] });

    await onPeer(repos, (peer) => peerSave(repos, peer, "x"));
    await runCycles(runtimePoller(s), s.sync);
    expectOrGap(
      gaps,
      "s5 void: RuntimeDataPoller does not invalidate",
      s.invalidations.count,
      1,
      0,
    );
    expectOrGap(
      gaps,
      "s5 void: S's query misses P's row",
      (await serveView(s, "x")).query,
      ["x@1"],
      [],
    );

    s.invalidations.count = 0;
    const loader = policyLoader(s);
    try {
      await loader.load();
      await onPeer(
        repos,
        (peer) => peerSaveGrant(peer, peerGrant(crypto.randomUUID(), "active")),
      );
      await runCycles(accessPoller(s, loader), s.sync);
      expectOrGap(
        gaps,
        "s5 void: AccessDataPoller does not invalidate",
        s.invalidations.count,
        1,
        0,
      );
      expectOrGap(
        gaps,
        "s5 void: S's policy still denies P's grant",
        decision(loader),
        "allow",
        "deny",
      );
    } finally {
      await loader.dispose();
    }
  });
  assertGaps(gaps, "s5");
});

// ---------------------------------------------------------------------------
// Scenario 6: the sync gate

/** Serve's gate, counting queued exclusive acquisitions. */
class CountingGate extends ReadWriteLock {
  queuedAcquires = 0;

  override acquire(signal?: AbortSignal): Promise<void> {
    this.queuedAcquires++;
    return super.acquire(signal);
  }
}

Deno.test("RuntimeDataPoller: s6 a poll skips while the gate is held, escalates, and pulls ahead of later acquirers", async () => {
  await withRowRepos({}, async (repos) => {
    const s = serveSide(repos);
    const gate = new CountingGate();
    assertEquals(await serveView(s, "x"), { latest: null, query: [] });
    await onPeer(repos, (peer) => peerSave(repos, peer, "x"));

    // Held exclusively, as a gated write request holds it.
    await gate.acquire();
    const held = gate.queuedAcquires;
    const poller = runtimePoller(s, gate);
    const order: string[] = [];
    poller.start();
    try {
      // Opportunistic cycles never queue; after the skips the poller
      // queues for the gate instead.
      await waitFor(
        () => gate.waiters === 1,
        `poller queued after ${POLLER_ESCALATE_AFTER_SKIPS} skips`,
      );
      assertEquals(gate.queuedAcquires - held, 1);
      assertEquals(s.sync.pullsCompleted, 0, "no pull while the gate is held");

      // A later exclusive acquirer waits behind the queued poller.
      const later = gate.acquire().then(() => {
        order.push(`acquired after ${s.sync.pullsCompleted} pull(s)`);
        gate.release();
      });
      gate.release();
      await later;
    } finally {
      await poller.stop();
    }
    assertEquals(order, ["acquired after 1 pull(s)"]);
    assertEquals(s.invalidations.count, 1);
    assertEquals(await serveView(s, "x"), { latest: "x@1", query: ["x@1"] });
  });
});

Deno.test("RuntimeDataPoller: s6 polls never overlap gated serve requests", async () => {
  await withRowRepos({}, async (repos) => {
    const s = serveSide(repos);
    const gate = new ReadWriteLock();
    const own = await saveModel(repos.serveRepo, "m1");
    await saveData(repos.serveRepo, own, "name-0");
    await settle(repos);
    const ctx = createServeCtx(repos.serveRepo, undefined, {
      syncService: s.sync,
      syncGate: gate,
      activeRunRegistry: new ActiveRunRegistry(),
      vaultsDir: repos.a.vaultsDir,
    });
    const poller = runtimePoller(s, gate);
    poller.start();
    try {
      for (let i = 0; i < 5; i++) {
        const pulls = s.sync.pullsCompleted;
        await runServe(ctx, {
          type: "data.rename",
          payload: {
            modelIdOrName: "m1",
            oldName: `name-${i}`,
            newName: `name-${i + 1}`,
          },
        });
        await waitFor(
          () => s.sync.pullsCompleted > pulls,
          "a poll between requests",
        );
      }
    } finally {
      await poller.stop();
    }
    assertEquals(s.sync.overlaps, []);
  });
});
