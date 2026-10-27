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
 * swamp-club#4004: an output-retention batch exports its phases through the
 * real OTLP exporter, with parentage, value types, outcomes and counts
 * intact. Runs the real retention pass and collectors over a real repository,
 * each batch wrapped as serve wraps it (the sync gate, then a root unit of
 * work whose flush stands in for the push); spans are exported over HTTP to
 * a port-0 collector (design/enablers/serve-phase-telemetry.md).
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  type Sampler,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RetentionPolicy } from "../src/domain/retention/retention_policy.ts";
import type { DatastorePathResolver } from "../src/domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../src/domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { flushDatastoreSync } from "../src/infrastructure/persistence/datastore_sync_coordinator.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import { SWAMP_SUBDIRS } from "../src/infrastructure/persistence/paths.ts";
import { YamlOutputRepository } from "../src/infrastructure/persistence/yaml_output_repository.ts";
import { FetchOtlpExporter } from "../src/infrastructure/tracing/fetch_otlp_exporter.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import { resolveDatastoreForRepo } from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import { createSyncGate, withSyncGate } from "../src/serve/sync_gate.ts";
import { runRepoRetention } from "../src/libswamp/retention/run.ts";
import type { RetentionPassResult } from "../src/libswamp/retention/pass.ts";
import {
  DAY_MS,
  saveAgedOutput,
} from "../src/libswamp/retention/retention_fixture_test_helpers.ts";

await initializeLogging({});

const OUTPUT_TYPE = ModelType.create("command/shell");

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
  attributes: { key: string; value: OtlpValue }[];
  status?: { code?: number };
}

interface OtlpRequest {
  resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
}

/**
 * Runs `fn` with spans exported over HTTP by {@link FetchOtlpExporter} to a
 * port-0 collector, and hands back every span it received. With `sampler`,
 * the provider samples by it instead of always.
 */
async function withExportedSpans(
  fn: () => Promise<void>,
  sampler?: Sampler,
): Promise<OtlpSpan[]> {
  const received: OtlpRequest[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      received.push(await request.json() as OtlpRequest);
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const provider = new BasicTracerProvider(sampler ? { sampler } : {});
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
    await fn();
    await provider.forceFlush();
  } finally {
    uninstallExecutionObserver();
    await provider.shutdown();
    trace.disable();
    context.disable();
    await server.shutdown();
  }
  return received.flatMap((request) =>
    request.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans)
    )
  );
}

function attribute(span: OtlpSpan, key: string): OtlpValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

function intOf(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, key)?.intValue;
  return value === undefined ? undefined : Number(value);
}

/** A number exported as an int or a double, whichever it happened to be. */
function numberOf(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, key);
  return value?.doubleValue ?? intOf(span, key);
}

function only(spans: OtlpSpan[], name: string): OtlpSpan {
  const matches = spans.filter((s) => s.name === name);
  assertEquals(matches.length, 1, `exactly one ${name}`);
  return matches[0];
}

function childOf(child: OtlpSpan, parent: OtlpSpan): boolean {
  return child.parentSpanId === parent.spanId &&
    child.traceId === parent.traceId;
}

/** Every span under `root`, `root` excluded. */
function descendants(spans: OtlpSpan[], root: OtlpSpan): OtlpSpan[] {
  const below = spans.filter((s) => childOf(s, root));
  return below.flatMap((s) => [s, ...descendants(spans, s)]);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-retention-phases-" });
  try {
    await fn(dir);
  } finally {
    await flushDatastoreSync().catch(() => {});
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

interface Repo {
  repoDir: string;
  resolver: DatastorePathResolver;
  outputs: YamlOutputRepository;
}

async function initRepo(dir: string): Promise<Repo> {
  const repoDir = join(dir, "repo");
  await Deno.mkdir(repoDir, { recursive: true });
  const homeDir = join(dir, "home");
  await new RepoService(VERSION, {
    homeDir,
    configDir: join(homeDir, ".config", "swamp"),
  }).init(RepoPath.create(repoDir), { tools: [] });
  const { datastoreConfig } = await resolveDatastoreForRepo(repoDir);
  const resolver = new DefaultDatastorePathResolver(repoDir, datastoreConfig);
  return {
    repoDir,
    resolver,
    outputs: new YamlOutputRepository(
      repoDir,
      resolver.resolvePath(SWAMP_SUBDIRS.outputs),
    ),
  };
}

/**
 * One output-retention pass with each batch wrapped as serve wraps it: the
 * sync gate, then a root unit of work whose flush is the push.
 */
function runOutputRetention(
  repo: Repo,
  markDirty: MarkDirtyHook,
): Promise<RetentionPassResult> {
  const gate = createSyncGate();
  return runRepoRetention(
    {
      repoDir: repo.repoDir,
      datastoreResolver: repo.resolver,
      markDirty,
      runBatch: (fn) =>
        withSyncGate(
          gate,
          () =>
            runInRootUnitOfWork(
              { markDirty, commitLog: undefined },
              { flush: () => Promise.resolve() },
              fn,
            ),
        ),
    },
    { policy: RetentionPolicy.fromConfig({ outputs: "1d" }) },
  );
}

const noDirtyMarks: MarkDirtyHook = () => Promise.resolve();

/** The outputs batch and its `retention_batch` phase. */
function outputBatch(spans: OtlpSpan[]): {
  batch: OtlpSpan;
  phase: OtlpSpan;
} {
  const batch = only(spans, "swamp.retention.batch");
  assertEquals(attribute(batch, "retention.kind")?.stringValue, "outputs");
  const phase = only(spans, "swamp.diagnostic.retention_batch");
  assert(childOf(phase, batch));
  return { batch, phase };
}

Deno.test("output retention phases: a batch exports its stages through OTLP with parentage, types and fixture counts", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir);
    for (let i = 0; i < 3; i++) {
      await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 10 * DAY_MS);
    }
    await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 10 * DAY_MS, {
      running: true,
    });
    await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 60_000);

    let result: RetentionPassResult | undefined;
    const spans = await withExportedSpans(async () => {
      result = await runOutputRetention(repo, noDirtyMarks);
    });

    assertEquals(result?.kinds[0].deleted, 3);
    const { batch, phase } = outputBatch(spans);
    assertEquals(intOf(batch, "retention.deleted"), 3);
    assertEquals(attribute(batch, "retention.more")?.boolValue, false);
    assertEquals(
      intOf(batch, "retention.bytes_reclaimed"),
      result?.kinds[0].bytesReclaimed,
    );
    assertEquals(
      attribute(phase, "swamp.diagnostic.area")?.stringValue,
      "output_retention",
    );
    assertEquals(attribute(phase, "swamp.outcome")?.stringValue, "ok");
    assertEquals(phase.status?.code, 1);
    assertEquals(intOf(phase, "swamp.diagnostic.deleted"), 3);

    // The gate wait is the existing gate span, tagged; every stage is a
    // child of the batch phase.
    const gateWait = only(spans, "swamp.serve.sync_gate.wait");
    assertEquals(
      attribute(gateWait, "swamp.diagnostic.phase")?.stringValue,
      "gate_wait",
    );
    for (
      const stage of [
        "candidate_enumeration",
        "candidate_scan",
        "orphan_log_sweep",
        "batch_commit",
      ]
    ) {
      const span = only(spans, `swamp.diagnostic.${stage}`);
      assert(childOf(span, phase), `${stage} is under retention_batch`);
      assertEquals(attribute(span, "swamp.outcome")?.stringValue, "ok");
    }
    assert(childOf(gateWait, phase), "gate_wait is under retention_batch");

    const scan = only(spans, "swamp.diagnostic.candidate_scan");
    assertEquals(intOf(scan, "swamp.diagnostic.considered"), 5);
    assertEquals(intOf(scan, "swamp.diagnostic.eligible"), 3);
    assertEquals(intOf(scan, "swamp.diagnostic.deleted"), 3);
    assertEquals(intOf(scan, "swamp.diagnostic.failed"), 0);
    assertEquals(intOf(scan, "swamp.diagnostic.protected_not_terminal"), 1);
    assertEquals(intOf(scan, "swamp.diagnostic.skipped_recent_mtime"), 1);
    assertEquals(
      attribute(scan, "swamp.diagnostic.stopped_at_limit")?.boolValue,
      false,
    );
    assertEquals(
      typeof numberOf(scan, "swamp.diagnostic.stat_work_ms"),
      "number",
    );
    assertEquals(typeof numberOf(phase, "swamp.phase.uncovered_ms"), "number");
    assertEquals(
      intOf(
        only(spans, "swamp.diagnostic.candidate_enumeration"),
        "swamp.diagnostic.files",
      ),
      5,
    );

    // No exported value carries a path.
    for (const span of spans) {
      for (const { value } of span.attributes) {
        assert(!(value.stringValue ?? "").includes(dir));
      }
    }
  });
});

Deno.test("output retention phases: a batch that fails after deleting some outputs exports its partial counts with the error", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir);
    for (let i = 0; i < 4; i++) {
      await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 10 * DAY_MS);
    }
    const signalled = new Set<string>();
    const failOnThird: MarkDirtyHook = (path) => {
      if (path?.endsWith(".yaml")) {
        signalled.add(path);
        if (signalled.size === 3) {
          return Promise.reject(new Error("datastore unavailable"));
        }
      }
      return Promise.resolve();
    };

    let result: RetentionPassResult | undefined;
    const spans = await withExportedSpans(async () => {
      result = await runOutputRetention(repo, failOnThird);
    });

    assertEquals(result?.kinds[0].complete, false);
    const { batch, phase } = outputBatch(spans);
    assertEquals(batch.status?.code, 2);
    assertEquals(attribute(phase, "swamp.outcome")?.stringValue, "error");
    const scan = only(spans, "swamp.diagnostic.candidate_scan");
    assertEquals(attribute(scan, "swamp.outcome")?.stringValue, "error");
    assertEquals(scan.status?.code, 2);
    assertEquals(intOf(scan, "swamp.diagnostic.delete_attempted"), 3);
    assertEquals(intOf(scan, "swamp.diagnostic.deleted"), 2);
    assertEquals(intOf(scan, "swamp.diagnostic.failed"), 1);
    assertEquals(
      spans.filter((s) => s.name === "swamp.diagnostic.orphan_log_sweep")
        .length,
      0,
    );
    // The unit was abandoned, which still pushes: its commit stage ran.
    const commit = only(spans, "swamp.diagnostic.batch_commit");
    assertEquals(
      attribute(commit, "swamp.diagnostic.disposition")?.stringValue,
      "abandon",
    );
    assertEquals(attribute(commit, "swamp.outcome")?.stringValue, "ok");
  });
});

Deno.test("output retention phases: an empty batch exports every stage with zero counts", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir);
    const spans = await withExportedSpans(async () => {
      await runOutputRetention(repo, noDirtyMarks);
    });
    outputBatch(spans);
    const scan = only(spans, "swamp.diagnostic.candidate_scan");
    assertEquals(intOf(scan, "swamp.diagnostic.considered"), 0);
    assertEquals(intOf(scan, "swamp.diagnostic.deleted"), 0);
    assertEquals(
      intOf(
        only(spans, "swamp.diagnostic.candidate_enumeration"),
        "swamp.diagnostic.files",
      ),
      0,
    );
  });
});

Deno.test("output retention phases: the span count of a batch does not grow with the number of outputs", async () => {
  const spansFor = async (count: number): Promise<number> => {
    let n = 0;
    await withTempDir(async (dir) => {
      const repo = await initRepo(dir);
      for (let i = 0; i < count; i++) {
        await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 10 * DAY_MS);
      }
      const spans = await withExportedSpans(async () => {
        const result = await runOutputRetention(repo, noDirtyMarks);
        assertEquals(result.kinds[0].deleted, count);
      });
      const { batch } = outputBatch(spans);
      n = descendants(spans, batch).length;
    });
    return n;
  };
  assertEquals(await spansFor(10), await spansFor(300));
});

Deno.test("output retention phases: with tracing configured but nothing sampled, the exporter receives nothing and the pass deletes the same", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir);
    for (let i = 0; i < 2; i++) {
      await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 10 * DAY_MS);
    }
    let result: RetentionPassResult | undefined;
    const spans = await withExportedSpans(async () => {
      result = await runOutputRetention(repo, noDirtyMarks);
    }, new AlwaysOffSampler());
    assertEquals(spans.length, 0);
    assertEquals(result?.kinds[0].deleted, 2);
    assertEquals(result?.kinds[0].complete, true);
  });
});

Deno.test("output retention phases: with tracing off the pass deletes the same", async () => {
  await withTempDir(async (dir) => {
    const repo = await initRepo(dir);
    for (let i = 0; i < 2; i++) {
      await saveAgedOutput(repo.outputs, OUTPUT_TYPE, 10 * DAY_MS);
    }
    const result = await runOutputRetention(repo, noDirtyMarks);
    assertEquals(result.kinds[0].deleted, 2);
    assertEquals(result.kinds[0].complete, true);
  });
});
