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

function int(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, key);
  if (value === undefined) return undefined;
  assert(value.intValue !== undefined, `${key} is exported as an integer`);
  return Number(value.intValue);
}

function bool(span: OtlpSpan, key: string): boolean | undefined {
  const value = attribute(span, key);
  if (value === undefined) return undefined;
  assert(value.boolValue !== undefined, `${key} is exported as a boolean`);
  return value.boolValue;
}

function d(key: string): string {
  return `swamp.diagnostic.${key}`;
}

interface PollTrace {
  root: OtlpSpan;
  cycle: OtlpSpan;
  spans: OtlpSpan[];
}

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

function underCycle(t: PollTrace, phase: string): OtlpSpan[] {
  return t.spans.filter((s) =>
    s.name === `swamp.diagnostic.${phase}` && s.parentSpanId === t.cycle.spanId
  );
}

function diagnosticSpans(t: PollTrace): OtlpSpan[] {
  return t.spans.filter((s) => s.name.startsWith("swamp.diagnostic."));
}

/**
 * a peer's save is several file writes, so a poll can apply a partial one;
 * select the poll that saw the finished write, not the first that applied
 * anything
 */
function appliedWithBuild(
  t: PollTrace,
  attribute: string,
  value: number,
): boolean {
  return str(t.cycle, d("result")) === "applied" &&
    underCycle(t, "snapshot_build").some((build) =>
      int(build, d(attribute)) === value
    );
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
              appliedWithBuild(t, "grants_active", 2)
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
      (t) => appliedWithBuild(t, "grants_active", 2),
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

Deno.test("access poll phases: a grant polled before its content lands is left out, and the poll after the content lands applies it", async () => {
  await withPair(async (pair) => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await saveGrant(pair.writer, ids[0]);
    const spans = await withExportedSpans(async (received) => {
      const poller = await localPoller(pair);
      await pair.loader.load();
      // Before the poller starts, so its first detection finds the save
      // already stopped between the metadata and the content.
      await saveGrant(pair.writer, ids[1]);
      const contentPath = pair.writer.repoContext.unifiedDataRepo
        .getContentPath(GRANT_MODEL_TYPE, ids[1], "grant-main", 1);
      const content = await Deno.readFile(contentPath);
      await Deno.remove(contentPath);
      poller.start();
      try {
        await waitFor(
          () =>
            pollTraces(received()).some((t) =>
              appliedWithBuild(t, "grants_active", 1)
            ),
          "a poll that applies the grant without its content",
        );
        await Deno.writeFile(contentPath, content);
        await waitFor(
          () =>
            pollTraces(received()).some((t) =>
              appliedWithBuild(t, "grants_active", 2)
            ),
          "a poll that applies the grant with its content",
        );
      } finally {
        await poller.stop();
      }
    });

    const [partial] = underCycle(
      findPoll(
        spans,
        (t) => appliedWithBuild(t, "grants_active", 1),
        "the partial poll",
      ),
      "snapshot_build",
    );
    assertEquals(int(partial, d("records_listed")), 2);
    assertEquals(int(partial, d("records_read")), 2);
    assertEquals(int(partial, d("unreadable")), 0);
    const [whole] = underCycle(
      findPoll(
        spans,
        (t) => appliedWithBuild(t, "grants_active", 2),
        "the whole poll",
      ),
      "snapshot_build",
    );
    assertEquals(int(whole, d("records_listed")), 2);
    assertEquals(int(whole, d("records_read")), 2);
    assertEquals(int(whole, d("unreadable")), 0);
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
              appliedWithBuild(t, "unreadable", 1)
            ),
          "a poll that reloads the corrupt record",
        );
      } finally {
        await poller.stop();
      }
    });
    const applied = findPoll(
      spans,
      (t) => appliedWithBuild(t, "unreadable", 1),
      "an applied poll",
    );
    const [build] = underCycle(applied, "snapshot_build");
    assertEquals(int(build, d("unreadable")), 1);
    assertEquals(int(build, d("records_read")), 1);
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
  assertEquals(small, 5);
  assertEquals(large, small);
});
