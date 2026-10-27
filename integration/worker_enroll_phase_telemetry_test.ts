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
 * swamp-club#3986: worker enrollment preparation exports its phases through
 * the real OTLP exporter, with parentage, value types and outcomes intact.
 * Wires a real repo, the real enrollment-token and worker models and a real
 * WorkerGateway with its default model runner; spans are exported over HTTP
 * to a port-0 collector (design/enablers/serve-phase-telemetry.md).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { configure, type LogRecord } from "@logtape/logtape";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { waitFor } from "@swamp-club/swamp-testing";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "../src/domain/vaults/control_plane_vault_provider.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { RpcChannel } from "../src/domain/remote/rpc_channel.ts";
import {
  type EnrollResult,
  REMOTE_PROTOCOL_VERSION,
  RemoteMethod,
} from "../src/domain/remote/protocol.ts";
import { workerDefinitionName } from "../src/domain/models/worker/worker_model.ts";
import { handleWorkerTokenCreate } from "../src/serve/handlers/admin_handlers.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  fleetMemberSuffix,
  WorkerGateway,
} from "../src/serve/worker_gateway.ts";
import { createAutoDefinitionLock } from "../src/libswamp/models/direct_execution.ts";
import { FetchOtlpExporter } from "../src/infrastructure/tracing/fetch_otlp_exporter.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const VERSION = "20260101.120000.0";

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
 * port-0 collector, and hands back every span it received.
 */
async function withExportedSpans(
  fn: () => Promise<void>,
): Promise<OtlpSpan[]> {
  const received: OtlpRequest[] = [];
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let provider: BasicTracerProvider | undefined;
  try {
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      async (request) => {
        received.push(await request.json() as OtlpRequest);
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      },
    );
    provider = new BasicTracerProvider();
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
    await fn();
    await provider.forceFlush();
  } finally {
    uninstallExecutionObserver();
    await provider?.shutdown();
    trace.disable();
    context.disable();
    await server?.shutdown();
  }
  return received.flatMap((request) =>
    request.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans)
    )
  );
}

/** Lock-contention warnings, captured so a test can wait for a retry. */
const lockWarnings: string[] = [];
await configure({
  sinks: {
    capture: (record: LogRecord) =>
      void lockWarnings.push(record.message.map(String).join("")),
  },
  loggers: [
    {
      category: ["datastore", "lock"],
      lowestLevel: "info",
      sinks: ["capture"],
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "error",
      sinks: [],
    },
  ],
  reset: true,
});

interface Fixture {
  repoDir: string;
  repoContext: RepositoryContext;
  tokenName: string;
  secret: string;
  /** Starts an enroll call from a fresh socket. */
  enroll(
    machineId: string,
    options?: { token?: string; signal?: AbortSignal },
  ): { call: Promise<EnrollResult>; drop: () => void };
}

async function withEnrollmentFixture(
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-enroll-phases-" });
  let repoContext: RepositoryContext | undefined;
  let registered = false;
  let gateway: WorkerGateway | undefined;
  const channels: RpcChannel[] = [];
  try {
    const initEvents = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(VERSION), {
        path: repoDir,
        force: false,
        version: VERSION,
        tools: [],
      }),
    );
    assertEquals(initEvents.some((event) => event.kind === "error"), false);
    repoContext = createRepositoryContext({ repoDir });
    const provider = new ControlPlaneVaultProvider(
      new FileSystemControlPlaneStore(swampPath(repoDir)),
    );
    await provider.initialize();
    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );
    registered = true;
    const live = new WorkerGateway({
      repoDir,
      repoContext,
      capabilityService: { registerHandlers: () => {} },
      graceWindowMs: 60_000,
    });
    gateway = live;
    const tokenName = `fleet-${crypto.randomUUID().slice(0, 8)}`;
    const socket = {
      readyState: WebSocket.OPEN,
      sent: [] as string[],
      send(data: string) {
        this.sent.push(data);
      },
      close() {},
    };
    await handleWorkerTokenCreate(
      socket as unknown as WebSocket,
      {
        repoDir,
        repoContext,
        datastoreConfig: { type: "filesystem" },
        datastoreResolver: {},
        authConfig: { mode: "none" },
      } as unknown as ConnectionContext,
      "req-create",
      { name: tokenName, durationMs: 60 * 60_000, maxEnrollments: 50 },
      new AbortController(),
      null,
    );
    const created = JSON.parse(socket.sent[0]);
    assertEquals(created.type, "worker.token.create", socket.sent[0]);
    const token = created.payload.data.token as string;
    await fn({
      repoDir,
      repoContext,
      tokenName,
      secret: token.slice(tokenName.length + 1),
      enroll(machineId, options = {}) {
        const channel: RpcChannel = new RpcChannel({
          send: (data) =>
            void Promise.resolve().then(() => attached.feed(data)),
        });
        channels.push(channel);
        const attached = live.attachTransport({
          send: (data) =>
            void Promise.resolve().then(() => channel.handleRaw(data)),
        }, () => attached.closed());
        const call = channel.call<EnrollResult>(RemoteMethod.enroll, {
          token: options.token ?? token,
          instanceUuid: crypto.randomUUID(),
          machineId,
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          swampVersion: "1.0.0",
          platform: "linux",
          arch: "x86_64",
          labels: {},
        }, { signal: options.signal });
        return {
          call,
          drop: () => {
            attached.closed();
            channel.close("test drop");
          },
        };
      },
    });
    await live.settled();
  } finally {
    for (const channel of channels) channel.close("test done");
    gateway?.dispose();
    if (registered) {
      VaultService.unregisterGlobalProvider(TOKEN_SECRETS_VAULT_NAME);
    }
    repoContext?.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function attribute(span: OtlpSpan, key: string): OtlpValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

function str(span: OtlpSpan, key: string): string | undefined {
  return attribute(span, key)?.stringValue;
}

function num(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, key);
  if (value?.intValue !== undefined) return Number(value.intValue);
  return value?.doubleValue;
}

/** One enrollment's spans: the trace its `swamp.enrollment.request` roots. */
interface EnrollmentTrace {
  request: OtlpSpan;
  spans: OtlpSpan[];
}

/** Enrollment traces in the order their requests started. */
function enrollmentTraces(spans: OtlpSpan[]): EnrollmentTrace[] {
  return spans
    .filter((s) => s.name === "swamp.enrollment.request")
    .sort((a, b) =>
      Number(BigInt(a.startTimeUnixNano) - BigInt(b.startTimeUnixNano))
    )
    .map((request) => ({
      request,
      spans: spans.filter((s) => s.traceId === request.traceId),
    }));
}

function phases(t: EnrollmentTrace, phase: string): OtlpSpan[] {
  return t.spans.filter((s) => s.name === `swamp.diagnostic.${phase}`);
}

/** The phases under the worker `enroll` method run of `t`. */
function workerRun(t: EnrollmentTrace): OtlpSpan[] {
  const run = t.spans.find((s) =>
    s.name === "swamp.model.method.run" &&
    str(s, "model.type") === "swamp/worker"
  ) ?? t.spans.find((s) =>
    s.name === "swamp.model.method.run" &&
    str(s, "method.name") === "enroll"
  );
  assert(run, "a worker enroll method run");
  const under = new Set([run.spanId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const span of t.spans) {
      if (
        span.parentSpanId && under.has(span.parentSpanId) &&
        !under.has(span.spanId)
      ) {
        under.add(span.spanId);
        grew = true;
      }
    }
  }
  return t.spans.filter((s) => under.has(s.spanId) && s.spanId !== run.spanId);
}

function named(spans: OtlpSpan[], phase: string): OtlpSpan[] {
  return spans.filter((s) => s.name === `swamp.diagnostic.${phase}`);
}

/**
 * `spans` ordered by the string attribute `key`. Each span is its own export
 * request, so the collector receives them in no fixed order.
 */
function sortedBy(spans: OtlpSpan[], key: string): OtlpSpan[] {
  return spans.toSorted((a, b) =>
    (str(a, key) ?? "").localeCompare(str(b, key) ?? "")
  );
}

function byId(spans: OtlpSpan[], id: string | undefined): OtlpSpan | undefined {
  return spans.find((s) => s.spanId === id);
}

/** Waits until a lock waiter has found the lock held at least once. */
async function waitForLockRetry(lockPath: string): Promise<void> {
  await waitFor(
    () => lockWarnings.some((w) => w.includes(lockPath)),
    "the enrollment to find the auto-definition lock held",
  );
}

async function workerNameFor(tokenName: string, machineId: string) {
  return `${tokenName}-${await fleetMemberSuffix(machineId)}`;
}

/** Writes `count` uuid-named worker auto-definitions, which the name index parses. */
async function addWorkerDefinitions(
  repoContext: RepositoryContext,
  count: number,
): Promise<void> {
  const dir = join(repoContext.autoDefinitionsDir, "swamp", "worker");
  await Deno.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(
      join(dir, `${id}.yaml`),
      `type: swamp/worker\nid: ${id}\nname: worker-filler-${i}\nversion: 1\n`,
    );
  }
}

Deno.test("enrollment phases: new and existing workers export their lookups, lock, save and adoption through OTLP", async () => {
  let secret = "";
  let repoDir = "";
  let tokenName = "";
  const spans = await withExportedSpans(() =>
    withEnrollmentFixture(async (f) => {
      ({ secret, repoDir, tokenName } = f);
      const first = f.enroll("machine-1");
      await first.call;
      // The same machine enrolls again from a new process after a drop.
      first.drop();
      await f.enroll("machine-1").call;
    })
  );
  const [created, reused] = enrollmentTraces(spans);
  assert(created && reused, "two enrollment traces");

  // --- A new worker: miss, lock, re-check under it, save ---
  const run = workerRun(created);
  const prepare = named(run, "prepare");
  assertEquals(prepare.length, 1);
  const lookups = sortedBy(
    named(run, "definition_lookup"),
    "swamp.diagnostic.lookup_attempt",
  );
  assertEquals(
    lookups.map((s) => [
      str(s, "swamp.diagnostic.lookup_attempt"),
      attribute(s, "swamp.diagnostic.hit")?.boolValue,
      str(s, "swamp.diagnostic.lookup_method"),
      str(s, "swamp.diagnostic.definition_type"),
    ]),
    [
      ["initial", false, "none", "swamp/worker"],
      ["recheck", false, "none", "swamp/worker"],
    ],
  );
  const [wait] = named(run, "lock_wait");
  const [held] = named(run, "lock_held");
  const [save] = named(run, "definition_save");
  assertEquals(str(wait, "swamp.diagnostic.lock_kind"), "auto_definition");
  assertEquals(attribute(wait, "swamp.diagnostic.acquired")?.boolValue, true);
  assertEquals(num(wait, "swamp.diagnostic.retries"), 0);
  assertEquals(str(save, "swamp.diagnostic.definition_outcome"), "created");
  // Parentage survives export: save and re-check under the hold, the hold
  // and wait under prepare, prepare under the method run.
  assertEquals(save.parentSpanId, held.spanId);
  assertEquals(byId(run, lookups[1].parentSpanId)?.spanId, held.spanId);
  assertEquals(wait.parentSpanId, prepare[0].spanId);
  assertEquals(held.parentSpanId, prepare[0].spanId);
  // Each miss scanned the primary root and asked the name index; the scans
  // inherit their lookup's attempt label.
  for (const lookup of lookups) {
    const scans = sortedBy(
      run.filter((s) =>
        s.name === "swamp.diagnostic.definition_scan" &&
        s.parentSpanId === lookup.spanId
      ),
      "swamp.diagnostic.scan_strategy",
    );
    assertEquals(
      scans.map((s) => [
        str(s, "swamp.diagnostic.scan_strategy"),
        str(s, "swamp.diagnostic.lookup_attempt"),
      ]),
      [
        ["full_listing", str(lookup, "swamp.diagnostic.lookup_attempt")],
        ["name_index", str(lookup, "swamp.diagnostic.lookup_attempt")],
      ],
    );
  }
  assertEquals(named(run, "type_resolution").length, 1);
  // The transition's queue fields stay on the transition span.
  const transition = created.spans.find((s) =>
    s.name === "swamp.serve.transition"
  )!;
  assertEquals(
    typeof num(transition, "swamp.transition.queue_wait_ms"),
    "number",
  );
  assertEquals(
    named(created.spans, "registry_load").length,
    2,
    "one per method run: redeem and enroll",
  );
  assertEquals(
    attribute(created.request, "swamp.rpc.cancel_observed")?.boolValue,
    false,
  );
  const [tokens] = named(created.spans, "token_record_scan");
  assertEquals(num(tokens, "swamp.diagnostic.tokens"), 1);

  // --- The same worker again: a hit, adopted, no lock ---
  const again = workerRun(reused);
  const [hit] = named(again, "definition_lookup");
  assertEquals(attribute(hit, "swamp.diagnostic.hit")?.boolValue, true);
  assertEquals(str(hit, "swamp.diagnostic.source"), "auto");
  assertEquals(
    str(
      named(again, "definition_adopt")[0],
      "swamp.diagnostic.definition_outcome",
    ),
    "reused",
  );
  assertEquals(named(again, "lock_wait").length, 0);
  assertEquals(named(again, "definition_save").length, 0);

  // --- Value types, statuses and contents as a collector receives them ---
  for (
    const span of spans.filter((s) => s.name.startsWith("swamp.diagnostic."))
  ) {
    assertEquals(str(span, "swamp.diagnostic.area"), "enrollment", span.name);
    assertEquals(
      str(span, "swamp.diagnostic.phase"),
      span.name.slice("swamp.diagnostic.".length),
    );
    assertEquals(str(span, "swamp.outcome"), "ok", span.name);
    assertEquals(span.status?.code, 1, span.name);
    assertEquals(
      typeof num(span, "swamp.phase.uncovered_ms"),
      "number",
      span.name,
    );
    assertEquals(
      attribute(span, "swamp.diagnostic.cancel_observed")?.boolValue,
      false,
    );
    for (const { key, value } of span.attributes) {
      const text = value.stringValue ?? "";
      assert(!text.includes(secret), `${span.name} ${key} holds the secret`);
      assert(!text.includes(repoDir), `${span.name} ${key} holds a path`);
      assert(!text.includes(tokenName), `${span.name} ${key} holds a name`);
      if (key.endsWith("_ms")) {
        assert(value.stringValue === undefined, `${key} is numeric`);
      }
    }
  }
});

Deno.test("enrollment phases: a held auto-definition lock shows as lock_wait retries, apart from the work under it", async () => {
  const spans = await withExportedSpans(() =>
    withEnrollmentFixture(async (f) => {
      const workerName = await workerNameFor(f.tokenName, "machine-contended");
      const holder = createAutoDefinitionLock(
        f.repoContext.autoDefinitionsDir,
        workerDefinitionName(workerName),
      );
      await holder.acquire();
      const { call } = f.enroll("machine-contended");
      try {
        await waitForLockRetry(workerDefinitionName(workerName));
      } finally {
        await holder.release();
      }
      await call;
    })
  );
  const [contended] = enrollmentTraces(spans);
  const run = workerRun(contended);
  const [wait] = named(run, "lock_wait");
  const [held] = named(run, "lock_held");
  assertEquals(attribute(wait, "swamp.diagnostic.acquired")?.boolValue, true);
  assert((num(wait, "swamp.diagnostic.retries") ?? 0) >= 1);
  // The wait and the hold are siblings: waiting is not counted as work.
  assertEquals(wait.parentSpanId, held.parentSpanId);
  assertEquals(named(run, "definition_save").length, 1);
});

Deno.test("enrollment phases: a worker that cancels before the server finishes is observed, and the phases still export", async () => {
  const spans = await withExportedSpans(() =>
    withEnrollmentFixture(async (f) => {
      const workerName = await workerNameFor(f.tokenName, "machine-cancel");
      const holder = createAutoDefinitionLock(
        f.repoContext.autoDefinitionsDir,
        workerDefinitionName(workerName),
      );
      await holder.acquire();
      const controller = new AbortController();
      const { call } = f.enroll("machine-cancel", {
        signal: controller.signal,
      });
      try {
        await waitForLockRetry(workerDefinitionName(workerName));
        controller.abort();
        await assertRejects(() => call);
      } finally {
        await holder.release();
      }
    })
  );
  const [cancelled] = enrollmentTraces(spans);
  assertEquals(
    attribute(cancelled.request, "swamp.rpc.cancel_observed")?.boolValue,
    true,
  );
  assertEquals(
    str(cancelled.request, "swamp.rpc.cancel_cause"),
    "cancel_frame",
  );
  assert((num(cancelled.request, "swamp.rpc.cancel_observed_ms") ?? -1) >= 0);
  const run = workerRun(cancelled);
  // Observed only: the server went on to finish the work it had started.
  const [save] = named(run, "definition_save");
  assertEquals(str(save, "swamp.outcome"), "ok");
  assertEquals(
    attribute(save, "swamp.diagnostic.cancel_observed")?.boolValue,
    true,
  );
  // The wait ended after the cancel; the scan before it did not see it.
  const initial = named(run, "definition_lookup").find((s) =>
    str(s, "swamp.diagnostic.lookup_attempt") === "initial"
  );
  assert(initial, "the initial lookup");
  assertEquals(
    attribute(initial, "swamp.diagnostic.cancel_observed")?.boolValue,
    false,
  );
  assertEquals(
    attribute(named(run, "lock_wait")[0], "swamp.diagnostic.cancel_observed")
      ?.boolValue,
    true,
  );
});

Deno.test("enrollment phases: an unknown token keeps the failed request and its lookup", async () => {
  const spans = await withExportedSpans(() =>
    withEnrollmentFixture(async (f) => {
      await assertRejects(() =>
        f.enroll("machine-x", { token: "no-such-token.secret" }).call
      );
    })
  );
  const [failed] = enrollmentTraces(spans);
  assertEquals(str(failed.request, "swamp.outcome"), "error");
  const [lookup] = phases(failed, "definition_lookup");
  assertEquals(
    str(lookup, "swamp.diagnostic.definition_type"),
    "swamp/enrollment-token",
  );
  assertEquals(attribute(lookup, "swamp.diagnostic.hit")?.boolValue, false);
  assertEquals(phases(failed, "token_record_scan").length, 1);
  // Nothing past the token check ran.
  assertEquals(phases(failed, "prepare").length, 0);
});

Deno.test("enrollment phases: the span count of an enrollment does not grow with the worker catalog", async () => {
  const spans = await withExportedSpans(() =>
    withEnrollmentFixture(async (f) => {
      await f.enroll("machine-warmup").call;
      await f.enroll("machine-small").call;
      await addWorkerDefinitions(f.repoContext, 300);
      await f.enroll("machine-large").call;
    })
  );
  const [, small, large] = enrollmentTraces(spans);
  const phaseCount = (t: EnrollmentTrace) =>
    t.spans.filter((s) =>
      s.name.startsWith("swamp.diagnostic.") ||
      s.name === "swamp.definition.name_index.validate"
    ).length;
  assertEquals(phaseCount(large), phaseCount(small));
  // The initial lookup's name index read the large catalog, and the
  // definition the enrollment before it saved. (The re-check under the lock
  // may read files written within the index's racy window again.)
  const initialRead = (t: EnrollmentTrace) =>
    num(
      named(workerRun(t), "definition_scan").find((s) =>
        str(s, "swamp.diagnostic.scan_strategy") === "name_index" &&
        str(s, "swamp.diagnostic.lookup_attempt") === "initial"
      )!,
      "swamp.diagnostic.files_read",
    ) ?? 0;
  assertEquals(initialRead(small), 1);
  assertEquals(initialRead(large), 301);
});
