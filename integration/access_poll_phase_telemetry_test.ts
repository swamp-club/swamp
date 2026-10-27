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
 * swamp-club#4005: an access-data poll exports its phases through the real
 * OTLP exporter, with parentage, value types, outcomes and counts intact.
 * Wires two instances of one checkout on a v2 filesystem datastore, the real
 * PolicySnapshotLoader, FilesystemAccessDataChangeSource, SyncGate and
 * AccessDataPoller; spans are exported over HTTP to a port-0 collector
 * (design/enablers/serve-phase-telemetry.md). The sync-pull branch uses an
 * in-process sync service over the same files, since a filesystem datastore
 * has none.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { waitFor } from "@swamp-club/swamp-testing";
import { Data } from "../src/domain/data/data.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
} from "../src/domain/models/access/grant_model.ts";
import { createModelUpdated } from "../src/domain/events/types.ts";
import {
  type DatastoreSyncService,
  SyncTimeoutError,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { resolverEngine } from "../src/domain/datastore/datastore_path_resolver.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  AccessDataPoller,
  createAccessDataPoller,
} from "../src/serve/access_data_poller.ts";
import {
  createSyncGate,
  POLLER_ESCALATE_AFTER_SKIPS,
  type SyncGate,
} from "../src/serve/sync_gate.ts";
import { FetchOtlpExporter } from "../src/infrastructure/tracing/fetch_otlp_exporter.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";

await initializeLogging({});

const POLL_INTERVAL_MS = 20;
const OTLP_STATUS_OK = 1;
const OTLP_STATUS_ERROR = 2;

interface OtlpValue {
  stringValue?: string;
  intValue?: number | string;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  attributes: { key: string; value: OtlpValue }[];
  status?: { code?: number };
}

interface OtlpRequest {
  resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
}

/**
 * Runs `fn` with spans exported over HTTP by {@link FetchOtlpExporter} to a
 * port-0 collector. `fn` can read what the collector has received so far;
 * the result is every span, after a flush.
 */
async function withExportedSpans(
  fn: (received: () => OtlpSpan[]) => Promise<void>,
): Promise<OtlpSpan[]> {
  const requests: OtlpRequest[] = [];
  const received = () =>
    requests.flatMap((request) =>
      request.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans)
      )
    );
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      requests.push(await request.json() as OtlpRequest);
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(
    new SimpleSpanProcessor(
      new FetchOtlpExporter({
        url: `http://127.0.0.1:${server.addr.port}/v1/traces`,
      }),
    ),
  );
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  provider.register();
  installExecutionObserver();
  try {
    await fn(received);
    await provider.forceFlush();
  } finally {
    uninstallExecutionObserver();
    await provider.shutdown();
    trace.disable();
    context.disable();
    await server.shutdown();
  }
  return received();
}

function attribute(span: OtlpSpan, key: string): OtlpValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

function str(span: OtlpSpan, key: string): string | undefined {
  return attribute(span, key)?.stringValue;
}

/** An integer attribute, failing if it was not exported as one. */
function int(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, key);
  if (value === undefined) return undefined;
  assert(value.intValue !== undefined, `${key} is exported as an integer`);
  return Number(value.intValue);
}

/** A boolean attribute, failing if it was not exported as one. */
function bool(span: OtlpSpan, key: string): boolean | undefined {
  const value = attribute(span, key);
  if (value === undefined) return undefined;
  assert(value.boolValue !== undefined, `${key} is exported as a boolean`);
  return value.boolValue;
}

function d(key: string): string {
  return `swamp.diagnostic.${key}`;
}

/** One access-data poll: its root `swamp.serve.poll` and its `poll_cycle`. */
interface PollTrace {
  root: OtlpSpan;
  cycle: OtlpSpan;
  spans: OtlpSpan[];
}

/** Access-data poll traces with a finished cycle, in the order they started. */
function pollTraces(spans: OtlpSpan[]): PollTrace[] {
  return spans
    .filter((s) =>
      s.name === "swamp.serve.poll" &&
      str(s, "swamp.serve.poller") === "access_data"
    )
    .sort((a, b) =>
      Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano))
    )
    .flatMap((root) => {
      const inTrace = spans.filter((s) => s.traceId === root.traceId);
      const cycle = inTrace.find((s) =>
        s.name === "swamp.diagnostic.poll_cycle"
      );
      return cycle ? [{ root, cycle, spans: inTrace }] : [];
    });
}

/** The trace's `phase` spans whose parent is the cycle. */
function underCycle(t: PollTrace, phase: string): OtlpSpan[] {
  return t.spans.filter((s) =>
    s.name === `swamp.diagnostic.${phase}` && s.parentSpanId === t.cycle.spanId
  );
}

function diagnosticSpans(t: PollTrace): OtlpSpan[] {
  return t.spans.filter((s) => s.name.startsWith("swamp.diagnostic."));
}

function findPoll(
  spans: OtlpSpan[],
  predicate: (t: PollTrace) => boolean,
  label: string,
): PollTrace {
  const found = pollTraces(spans).find(predicate);
  assert(found, label);
  return found;
}

/** Every access_poll phase of `t` carries the area and `mode`. */
function assertArea(t: PollTrace, mode: string): void {
  assertEquals(t.cycle.parentSpanId, t.root.spanId);
  for (const span of diagnosticSpans(t)) {
    assertEquals(str(span, d("area")), "access_poll", span.name);
    assertEquals(str(span, d("source_mode")), mode, span.name);
    assertEquals(
      span.name,
      `swamp.diagnostic.${str(span, d("phase"))}`,
    );
  }
}

type Instance = Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;

interface Pair {
  dir: string;
  writer: Instance;
  reader: Instance;
  loader: PolicySnapshotLoader;
}

/**
 * Two instances of one checkout on its default v2 filesystem datastore: the
 * writer saves records as a peer would, the reader runs serve's side.
 */
async function withPair(fn: (pair: Pair) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-access-poll-phases-" });
  let writer: Instance | undefined;
  let reader: Instance | undefined;
  let loader: PolicySnapshotLoader | undefined;
  try {
    const homeDir = join(dir, "home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    writer = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });
    reader = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "json",
    });
    loader = new PolicySnapshotLoader(
      reader.repoContext.unifiedDataRepo,
      reader.repoContext.eventBus,
      "manual",
      { runImpliesApprove: true, runImpliesSignal: true },
    );
    await fn({ dir, writer, reader, loader });
  } finally {
    await loader?.dispose();
    writer?.repoContext.catalogStore.close();
    reader?.repoContext.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** The local-change-source poller serve builds for a v2 filesystem datastore. */
async function localPoller(pair: Pair): Promise<AccessDataPoller> {
  const poller = await createAccessDataPoller({
    pollIntervalMs: POLL_INTERVAL_MS,
    policySnapshotLoader: pair.loader,
    catalogInvalidate: () => pair.reader.repoContext.catalogStore.invalidate(),
    datastoreConfig: pair.reader.datastoreConfig,
    datastoreEngine: resolverEngine(pair.reader.datastoreResolver),
    datastoreResolver: pair.reader.datastoreResolver,
    eventBus: pair.reader.repoContext.eventBus,
  });
  assert(poller, "a v2 filesystem datastore gets an access data poller");
  return poller;
}

/**
 * A sync service over the shared files: each pull reports the count the
 * test queued, or throws the error it queued.
 */
class QueuedSyncService implements DatastoreSyncService {
  pulls = 0;
  readonly #results: Array<number | void | Error> = [];

  queue(...results: Array<number | void | Error>): void {
    this.#results.push(...results);
  }

  pullChanged(): Promise<number | void> {
    this.pulls++;
    const next = this.#results.length > 0 ? this.#results.shift() : 0;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  pushChanged(): Promise<number | void> {
    return Promise.resolve(0);
  }

  markDirty(): Promise<void> {
    return Promise.resolve();
  }
}

function syncPoller(
  pair: Pair,
  sync: QueuedSyncService,
  gate: SyncGate,
): AccessDataPoller {
  return new AccessDataPoller({
    syncService: sync,
    syncGate: gate,
    pollIntervalMs: POLL_INTERVAL_MS,
    policySnapshotLoader: pair.loader,
    catalogInvalidate: () => pair.reader.repoContext.catalogStore.invalidate(),
  });
}

function grant(id: string): Grant {
  return {
    id,
    subject: { kind: "user", name: "phase-grantee" },
    effect: "allow",
    actions: ["read"],
    resource: { kind: "model", pattern: "phase-model" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/** Saves a grant record as a peer's model run does, raw bytes allowed. */
async function saveGrant(
  writer: Instance,
  modelId: string,
  content: Uint8Array = new TextEncoder().encode(
    JSON.stringify(grant(modelId)),
  ),
): Promise<void> {
  const { version } = await writer.repoContext.unifiedDataRepo.save(
    GRANT_MODEL_TYPE,
    modelId,
    Data.create({
      name: "grant-main",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: modelId },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${GRANT_MODEL_TYPE.normalized}:${modelId}`,
      },
    }),
    content,
  );
  // On the writer's bus only: to the reader this is a peer's change.
  await writer.repoContext.eventBus.publish(
    createModelUpdated(GRANT_MODEL_TYPE.normalized, modelId, modelId, [
      { name: "grant-main", version },
    ]),
  );
}

/** No diagnostic attribute names a path, a record id or record content. */
function assertNoPayloads(
  spans: OtlpSpan[],
  forbidden: readonly string[],
): void {
  for (const span of spans) {
    if (!span.name.startsWith("swamp.diagnostic.")) continue;
    for (const { key, value } of span.attributes) {
      const text = value.stringValue;
      if (text === undefined) continue;
      for (const secret of forbidden) {
        assert(!text.includes(secret), `${span.name} ${key} names ${secret}`);
      }
    }
  }
}

Deno.test("access poll phases: a local change source exports unchanged and changed polls, with real counts, through OTLP", async () => {
  await withPair(async (pair) => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await saveGrant(pair.writer, ids[0]);
    const spans = await withExportedSpans(async (received) => {
      const poller = await localPoller(pair);
      await pair.loader.load();
      poller.start();
      try {
        await waitFor(
          () => pollTraces(received()).length >= 1,
          "an unchanged poll",
        );
        await saveGrant(pair.writer, ids[1]);
        await waitFor(
          () =>
            pollTraces(received()).some((t) =>
              str(t.cycle, d("result")) === "applied"
            ),
          "a poll that applies the peer's grant",
        );
      } finally {
        await poller.stop();
      }
    });

    const unchanged = findPoll(
      spans,
      (t) => str(t.cycle, d("result")) === "no_change",
      "an unchanged poll",
    );
    assertArea(unchanged, "local_change_source");
    assertEquals(str(unchanged.cycle, d("reload_reason")), "none");
    assertEquals(str(unchanged.cycle, "swamp.outcome"), "ok");
    assertEquals(unchanged.cycle.status?.code, OTLP_STATUS_OK);
    assertEquals(int(unchanged.cycle, d("changed")), 0);
    assertEquals(bool(unchanged.cycle, d("cancel_observed")), false);
    assert(attribute(unchanged.cycle, "swamp.phase.uncovered_ms"));
    const [quiet] = underCycle(unchanged, "change_detection");
    assertEquals(int(quiet, d("records")), 1);
    assertEquals(int(quiet, d("changed")), 0);
    assertEquals(bool(quiet, d("baseline_missing")), false);
    assertEquals(
      diagnosticSpans(unchanged).map((s) => s.name).sort(),
      ["swamp.diagnostic.change_detection", "swamp.diagnostic.poll_cycle"],
    );

    const applied = findPoll(
      spans,
      (t) => str(t.cycle, d("result")) === "applied",
      "an applied poll",
    );
    assertArea(applied, "local_change_source");
    assertEquals(str(applied.cycle, d("reload_reason")), "changed");
    assertEquals(int(applied.cycle, d("changed")), 1);
    const [detection] = underCycle(applied, "change_detection");
    assertEquals(int(detection, d("records")), 2);
    assertEquals(int(detection, d("changed")), 1);
    assertEquals(int(detection, d("own_changes_excluded")), undefined);
    assertEquals(underCycle(applied, "catalog_invalidate").length, 1);
    const [queued] = underCycle(applied, "snapshot_queue_wait");
    assertEquals(int(queued, d("builds_ahead")), 0);
    const [build] = underCycle(applied, "snapshot_build");
    assertEquals(int(build, d("records_listed")), 2);
    assertEquals(int(build, d("records_read")), 2);
    assertEquals(int(build, d("grants_active")), 2);
    assertEquals(int(build, d("groups")), 0);
    assertEquals(int(build, d("unreadable")), 0);
    assertEquals(bool(build, d("snapshot_unchanged")), false);
    assert(attribute(build, d("read_work_ms")), "read_work_ms is exported");
    assertEquals(str(build, "swamp.outcome"), "ok");

    for (const t of pollTraces(spans)) {
      assertEquals(underCycle(t, "gate_wait").length, 0);
      assertEquals(underCycle(t, "remote_pull").length, 0);
    }
    assertNoPayloads(spans, [pair.dir, ...ids, "phase-grantee"]);
  });
});

Deno.test("access poll phases: a corrupt record is counted as unreadable, and the reload still applies", async () => {
  await withPair(async (pair) => {
    const id = crypto.randomUUID();
    await saveGrant(pair.writer, id);
    const spans = await withExportedSpans(async (received) => {
      const poller = await localPoller(pair);
      await pair.loader.load();
      poller.start();
      try {
        await saveGrant(
          pair.writer,
          id,
          new TextEncoder().encode("{ not json"),
        );
        await waitFor(
          () =>
            pollTraces(received()).some((t) =>
              str(t.cycle, d("result")) === "applied"
            ),
          "a poll that reloads the corrupt record",
        );
      } finally {
        await poller.stop();
      }
    });
    const applied = findPoll(
      spans,
      (t) => str(t.cycle, d("result")) === "applied",
      "an applied poll",
    );
    const [build] = underCycle(applied, "snapshot_build");
    assertEquals(int(build, d("unreadable")), 1);
    assertEquals(int(build, d("records_read")), 1);
    // A corrupt record is not retried on its own.
    assertEquals(str(build, "swamp.outcome"), "ok");
    assertNoPayloads(spans, [pair.dir, id, "not json"]);
  });
});

Deno.test("access poll phases: a sync pull exports the gate wait and the pull, its skips, its failures and a stop", async () => {
  await withPair(async (pair) => {
    const id = crypto.randomUUID();
    const sync = new QueuedSyncService();
    const gate = createSyncGate();
    const spans = await withExportedSpans(async () => {
      await pair.loader.load();
      const poller = syncPoller(pair, sync, gate);
      await saveGrant(pair.writer, id);
      sync.queue(
        1,
        undefined,
        new Error("bucket unreachable"),
        new SyncTimeoutError("access data poller", "pull", 5),
      );
      poller.start();
      try {
        await waitFor(() => sync.pulls >= 5, "four queued pulls and one more");
        // Hold the gate: the poller skips, escalates, then queues.
        await gate.acquireShared();
        await waitFor(() => gate.waiters === 1, "the poller queued");
      } finally {
        await poller.stop();
        gate.releaseShared();
      }
    });

    const traces = pollTraces(spans);
    const applied = traces.find((t) => str(t.cycle, d("result")) === "applied");
    assert(applied, "an applied pull");
    assertArea(applied, "sync_pull");
    const [wait] = underCycle(applied, "gate_wait");
    assertEquals(bool(wait, d("acquired")), true);
    assertEquals(str(wait, d("gate_mode")), "opportunistic");
    assertEquals(int(wait, d("attempts")), 1);
    const [pull] = underCycle(applied, "remote_pull");
    assertEquals(int(pull, d("changed")), 1);
    assertEquals(bool(pull, d("count_reported")), true);
    assertEquals(underCycle(applied, "catalog_invalidate").length, 1);
    const [build] = underCycle(applied, "snapshot_build");
    assertEquals(int(build, d("grants_active")), 1);
    assertEquals(underCycle(applied, "change_detection").length, 0);

    const noCount = traces.find((t) =>
      underCycle(t, "remote_pull").some((p) =>
        bool(p, d("count_reported")) === false
      )
    );
    assert(noCount, "a pull with no count");
    assertEquals(str(noCount.cycle, d("result")), "no_change");

    const failed = traces.filter((t) =>
      str(t.cycle, "swamp.outcome") === "error"
    );
    assertEquals(failed.length, 2);
    assertEquals(
      failed.map((t) => str(underCycle(t, "remote_pull")[0], "swamp.outcome")),
      ["error", "timeout"],
    );
    for (const t of failed) {
      assertEquals(t.cycle.status?.code, OTLP_STATUS_ERROR);
      assertEquals(str(t.cycle, d("result")), undefined);
    }
    assertEquals(int(failed[1].cycle, d("consecutive_failures")), 2);

    const skipped = traces.filter((t) =>
      str(t.cycle, d("result")) === "skipped"
    );
    // A cycle the interval queued before stop() cleared it also ends
    // cancelled, so the count after the queued one is not pinned.
    assert(skipped.length >= POLLER_ESCALATE_AFTER_SKIPS + 1);
    for (const t of skipped.slice(0, POLLER_ESCALATE_AFTER_SKIPS)) {
      assertEquals(str(t.cycle, "swamp.outcome"), "ok");
      assertEquals(int(t.cycle, d("changed")), undefined);
      const [busy] = underCycle(t, "gate_wait");
      assertEquals(bool(busy, d("acquired")), false);
      assertEquals(underCycle(t, "remote_pull").length, 0);
    }
    const stopped = skipped[POLLER_ESCALATE_AFTER_SKIPS];
    for (const t of skipped.slice(POLLER_ESCALATE_AFTER_SKIPS + 1)) {
      assertEquals(str(t.cycle, "swamp.outcome"), "cancelled");
    }
    assertEquals(str(stopped.cycle, "swamp.outcome"), "cancelled");
    assertEquals(bool(stopped.cycle, d("cancel_observed")), true);
    const [queuedWait] = underCycle(stopped, "gate_wait");
    assertEquals(str(queuedWait, d("gate_mode")), "queued");
    assertEquals(str(queuedWait, "swamp.outcome"), "cancelled");
    assertEquals(underCycle(stopped, "remote_pull").length, 0);
    assertNoPayloads(spans, [pair.dir, id, "bucket unreachable"]);
  });
});

/** chmod has no effect for root, and Windows has no POSIX modes. */
const IGNORE_CHMOD = Deno.build.os === "windows" || Deno.uid() === 0;

Deno.test({
  name:
    "access poll phases: a record that turns unreadable is counted, and each later poll retries it as unreadable_retry",
  ignore: IGNORE_CHMOD,
  fn: async () => {
    await withPair(async (pair) => {
      const id = crypto.randomUUID();
      await saveGrant(pair.writer, id);
      const dataDir = pair.reader.datastoreResolver.resolvePath(
        "data",
        "swamp",
        "grant",
        id,
        "grant-main",
      );
      const spans = await withExportedSpans(async (received) => {
        const poller = await localPoller(pair);
        await pair.loader.load();
        await Deno.chmod(dataDir, 0o000);
        try {
          poller.start();
          try {
            await waitFor(
              () =>
                pollTraces(received()).some((t) =>
                  str(t.cycle, d("reload_reason")) === "unreadable_retry"
                ),
              "a poll retrying the unreadable record",
            );
          } finally {
            await poller.stop();
          }
        } finally {
          await Deno.chmod(dataDir, 0o755);
        }
      });
      const changed = findPoll(
        spans,
        (t) => str(t.cycle, d("reload_reason")) === "changed",
        "the poll that saw the record turn unreadable",
      );
      const [detection] = underCycle(changed, "change_detection");
      assertEquals(int(detection, d("unreadable_entries")), 1);
      const [build] = underCycle(changed, "snapshot_build");
      assertEquals(int(build, d("unreadable")), 1);
      const retry = findPoll(
        spans,
        (t) => str(t.cycle, d("reload_reason")) === "unreadable_retry",
        "a retry",
      );
      assertEquals(int(retry.cycle, d("unreadable_records")), 1);
      assertEquals(int(retry.cycle, d("changed")), 0);
      assertEquals(str(retry.cycle, d("result")), "applied");
      assertEquals(underCycle(retry, "catalog_invalidate").length, 0);
      assertEquals(underCycle(retry, "snapshot_build").length, 1);
    });
  },
});

/** Saves `count` grants and returns the diagnostic span count of the poll that applies them. */
async function appliedPollSpanCount(count: number): Promise<number> {
  let phases = 0;
  await withPair(async (pair) => {
    const spans = await withExportedSpans(async (received) => {
      const poller = await localPoller(pair);
      await pair.loader.load();
      for (let i = 0; i < count; i++) {
        await saveGrant(pair.writer, crypto.randomUUID());
      }
      poller.start();
      try {
        await waitFor(
          () =>
            pollTraces(received()).some((t) =>
              str(t.cycle, d("result")) === "applied"
            ),
          "the applying poll",
        );
      } finally {
        await poller.stop();
      }
    });
    const applied = findPoll(
      spans,
      (t) => str(t.cycle, d("result")) === "applied",
      "the applying poll",
    );
    assertEquals(
      int(underCycle(applied, "snapshot_build")[0], d("records_read")),
      count,
    );
    phases = diagnosticSpans(applied).length;
  });
  return phases;
}

Deno.test("access poll phases: a poll's span count does not grow with the access catalog", async () => {
  const small = await appliedPollSpanCount(2);
  const large = await appliedPollSpanCount(300);
  // poll_cycle, change_detection, catalog_invalidate, snapshot_queue_wait,
  // snapshot_build.
  assertEquals(small, 5);
  assertEquals(large, small);
});
