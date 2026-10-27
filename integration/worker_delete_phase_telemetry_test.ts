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
 * swamp-club#4003: worker prune and each worker definition deletion export
 * their phases through the real OTLP exporter, with parentage, value types,
 * outcomes and counts intact. Wires a real repo, real worker definitions with
 * data, outputs and a referencing workflow, and the delete dependencies serve
 * builds; spans are exported over HTTP to a port-0 collector
 * (design/enablers/serve-phase-telemetry.md). The token listing and binding
 * prune are stubbed: they are the prune's ports, not the deletion under test.
 */

import { assert, assertEquals } from "@std/assert";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createModelDeleteDeps,
  modelDelete,
} from "../src/libswamp/models/delete.ts";
import type { ModelMethodRunEvent } from "../src/libswamp/models/run.ts";
import {
  type PrunableWorker,
  workerPrune,
  type WorkerPruneDeps,
  type WorkerPruneEvent,
} from "../src/libswamp/worker/prune.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { Data } from "../src/domain/data/mod.ts";
import { ModelOutput } from "../src/domain/models/model_output.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../src/domain/models/worker/worker_model.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { FetchOtlpExporter } from "../src/infrastructure/tracing/fetch_otlp_exporter.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const VERSION = "20260101.120000.0";
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN = "fleet";

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

function attribute(span: OtlpSpan, key: string): OtlpValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

function str(span: OtlpSpan, key: string): string | undefined {
  return attribute(span, key)?.stringValue;
}

/** A counter: exported as an OTLP integer, never a double or a string. */
function count(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, `swamp.diagnostic.${key}`);
  if (value === undefined) return undefined;
  assert(value.intValue !== undefined, `${span.name} ${key} is not an int`);
  return Number(value.intValue);
}

function phases(spans: OtlpSpan[], phase: string): OtlpSpan[] {
  return spans.filter((s) => s.name === `swamp.diagnostic.${phase}`);
}

function only(spans: OtlpSpan[], name: string): OtlpSpan {
  const matches = spans.filter((s) => s.name === name);
  assertEquals(matches.length, 1, `${name}: ${matches.length}`);
  return matches[0];
}

function isChildOf(child: OtlpSpan, parent: OtlpSpan): boolean {
  return child.parentSpanId === parent.spanId &&
    child.traceId === parent.traceId;
}

interface WorkerSpec {
  name: string;
  status?: string;
  /** How long ago the worker disconnected; omit for a connected worker. */
  disconnectedMsAgo?: number;
  data?: number;
  outputs?: number;
}

interface Fixture {
  repoDir: string;
  repoContext: RepositoryContext;
  /** Writes a worker definition with its data and outputs. */
  addWorker(spec: WorkerSpec): Promise<void>;
  /** Saves a workflow with a step that runs the worker's definition. */
  referenceWorker(name: string): Promise<void>;
  /** Prune dependencies as serve builds them, over the real repositories. */
  pruneDeps(): WorkerPruneDeps;
}

async function withPruneFixture(
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-prune-phases-" });
  let repoContext: RepositoryContext | undefined;
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
    const repos = createRepositoryContext({ repoDir });
    repoContext = repos;
    const specs: WorkerSpec[] = [];
    const deleteDeps = createModelDeleteDeps(
      repoDir,
      undefined,
      repos.unifiedDataRepo,
      repos.markDirty,
      repos.definitionRepo,
    );

    await fn({
      repoDir,
      repoContext: repos,
      async addWorker(spec) {
        specs.push(spec);
        const definition = Definition.create({
          name: workerDefinitionName(spec.name),
          type: WORKER_MODEL_TYPE.normalized,
          globalArguments: {},
        });
        await repos.definitionRepo.save(WORKER_MODEL_TYPE, definition);
        for (let i = 0; i < (spec.data ?? 0); i++) {
          await repos.unifiedDataRepo.save(
            WORKER_MODEL_TYPE,
            definition.id,
            Data.create({
              name: `state-${i}`,
              contentType: "application/json",
              lifetime: "infinite",
              garbageCollection: 10,
              tags: { type: "resource" },
              ownerDefinition: {
                ownerType: "model-method",
                ownerRef: `${WORKER_MODEL_TYPE.normalized}:enroll`,
              },
            }),
            new TextEncoder().encode("{}"),
          );
        }
        for (let i = 0; i < (spec.outputs ?? 0); i++) {
          await repos.outputRepo.save(
            WORKER_MODEL_TYPE,
            "set_status",
            ModelOutput.create({
              definitionId: definition.id,
              methodName: "set_status",
              // Distinct starts: an output's file name carries its start.
              startedAt: new Date(NOW - (i + 1) * 1000),
              provenance: {
                definitionHash: "abc123",
                modelVersion: "2026.02.09.1",
                triggeredBy: "manual",
              },
            }),
          );
        }
      },
      async referenceWorker(name) {
        await repos.workflowRepo.save(Workflow.create({
          name: `uses-${crypto.randomUUID().slice(0, 8)}`,
          jobs: [
            Job.create({
              name: "main",
              steps: [
                Step.create({
                  name: "status",
                  task: StepTask.modelMethod(
                    workerDefinitionName(name),
                    "set_status",
                  ),
                }),
              ],
            }),
          ],
        }));
      },
      pruneDeps: () => ({
        // The workers whose definitions are still in the repo.
        listWorkers: async () => {
          const workers: PrunableWorker[] = [];
          for (const spec of specs) {
            const definitionName = workerDefinitionName(spec.name);
            const found = await repos.definitionRepo.findByName(
              WORKER_MODEL_TYPE,
              definitionName,
            );
            if (!found) continue;
            workers.push({
              name: spec.name,
              definitionName,
              status: spec.status ?? "disconnected",
              tokenName: TOKEN,
              disconnectedAt: spec.disconnectedMsAgo === undefined
                ? undefined
                : new Date(NOW - spec.disconnectedMsAgo).toISOString(),
            });
          }
          return workers;
        },
        listTokens: () =>
          Promise.resolve([{
            name: TOKEN,
            bindings: specs.map((s) => ({ machineId: `machine-${s.name}` })),
          }]),
        deleteWorker: (definitionName) =>
          // As serve's worker GC wires it (src/cli/commands/serve.ts).
          deleteWorkerWith(deleteDeps, definitionName),
        resolveStaleBindings: (token, remaining) =>
          Promise.resolve(
            token.bindings
              .filter((b) =>
                !remaining.some((name) => b.machineId === `machine-${name}`)
              )
              .map((b) => b.machineId),
          ),
        pruneBindings: () => completedBindingPrune(),
        now: () => NOW,
      }),
    });
  } finally {
    repoContext?.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function deleteWorkerWith(
  deleteDeps: ReturnType<typeof createModelDeleteDeps>,
  definitionName: string,
) {
  return modelDelete(createLibSwampContext(), deleteDeps, {
    modelIdOrName: definitionName,
    force: true,
  });
}

async function* completedBindingPrune(): AsyncGenerator<ModelMethodRunEvent> {
  yield {
    kind: "completed",
    run: {
      modelId: "id",
      modelName: TOKEN,
      modelType: "swamp/enrollment-token",
      methodName: "prune_bindings",
      outputId: "id",
      status: "succeeded",
      duration: 1,
      dataArtifacts: [],
      logFile: "/log",
    },
  };
}

function prune(deps: WorkerPruneDeps): AsyncGenerator<WorkerPruneEvent> {
  return workerPrune(createLibSwampContext(), deps, {
    gracePeriodMs: DAY_MS,
    dryRun: false,
  });
}

Deno.test("worker prune: stages, counts, parentage and outcomes survive the OTLP export", async () => {
  await withPruneFixture(async (fixture) => {
    await fixture.addWorker({
      name: "pool-a",
      disconnectedMsAgo: 2 * DAY_MS,
      data: 2,
      outputs: 3,
    });
    await fixture.addWorker({
      name: "pool-ref",
      disconnectedMsAgo: 2 * DAY_MS,
      outputs: 1,
    });
    await fixture.referenceWorker("pool-ref");
    await fixture.addWorker({ name: "pool-live", status: "connected" });
    await fixture.addWorker({
      name: "pool-new",
      disconnectedMsAgo: 60_000,
    });

    let events: WorkerPruneEvent[] = [];
    const spans = await withExportedSpans(async () => {
      events = await collect(prune(fixture.pruneDeps()));
    });

    const completed = events.find((e) => e.kind === "completed");
    assert(completed?.kind === "completed");
    assertEquals(completed.result.workersDeleted, 1);
    assertEquals(completed.result.workersFailed, 1);

    const root = only(spans, "swamp.worker.prune");
    const pass = only(spans, "swamp.diagnostic.prune_pass");
    assert(isChildOf(pass, root));
    for (const stage of ["worker_listing", "eligibility", "delete_loop"]) {
      assert(isChildOf(phases(spans, stage)[0], pass), stage);
    }
    const cleanup = only(spans, "swamp.diagnostic.binding_cleanup");
    assert(isChildOf(cleanup, pass));

    const eligibility = only(spans, "swamp.diagnostic.eligibility");
    assertEquals(count(eligibility, "considered"), 4);
    assertEquals(count(eligibility, "eligible"), 2);
    assertEquals(count(eligibility, "skipped_not_disconnected"), 1);
    assertEquals(count(eligibility, "skipped_within_grace"), 1);

    const loop = only(spans, "swamp.diagnostic.delete_loop");
    assertEquals(
      attribute(loop, "swamp.diagnostic.sequential")?.boolValue,
      true,
    );
    assertEquals(count(loop, "batch_size"), 2);
    assertEquals(count(loop, "attempted"), 2);
    assertEquals(count(loop, "deleted"), 1);
    assertEquals(count(loop, "failed"), 1);
    assertEquals(str(loop, "swamp.diagnostic.result"), "partial");
    assertEquals(str(pass, "swamp.diagnostic.result"), "partial");

    // Each worker's delete nests under the loop, its phases under it.
    const deletes = spans.filter((s) => s.name === "swamp.model.delete");
    assertEquals(deletes.length, 2);
    const models = phases(spans, "model_delete");
    for (const model of models) {
      assert(deletes.some((d) => isChildOf(d, loop) && isChildOf(model, d)));
    }
    const refused = models.find((m) =>
      str(m, "swamp.diagnostic.refusal") === "workflow_referenced"
    );
    assert(refused);
    assertEquals(str(refused, "swamp.outcome"), "error");
    assertEquals(refused.status?.code, 2);
    const deleted = models.find((m) => m !== refused)!;
    assertEquals(str(deleted, "swamp.outcome"), "ok");
    assertEquals(deleted.status?.code, 1);
    assertEquals(
      str(deleted, "swamp.diagnostic.definition_type"),
      WORKER_MODEL_TYPE.normalized,
    );

    const under = (phase: string, model: OtlpSpan) =>
      phases(spans, phase).filter((s) => isChildOf(s, model));
    assertEquals(under("workflow_reference_check", refused).length, 1);
    assertEquals(
      count(under("workflow_reference_check", refused)[0], "referencing"),
      1,
    );
    // The refusal stops before discovery and removal.
    assertEquals(under("output_discovery", refused).length, 0);

    for (
      const stage of [
        "definition_resolve",
        "workflow_reference_check",
        "data_discovery",
        "expiry_check",
        "output_discovery",
        "output_removal",
        "data_removal",
        "evaluated_removal",
        "definition_removal",
      ]
    ) {
      assertEquals(under(stage, deleted).length, 1, stage);
    }
    // The delete resolves by name across every type: a walk of the
    // definitions, counted on the resolve phase.
    const resolve = under("definition_resolve", deleted)[0];
    assertEquals(attribute(resolve, "swamp.diagnostic.hit")?.boolValue, true);
    assertEquals(count(resolve, "primary_walks"), 1);
    assert(count(resolve, "files_read")! >= 1);
    assertEquals(count(under("data_discovery", deleted)[0], "artifacts"), 2);
    const discovery = under("output_discovery", deleted)[0];
    assertEquals(count(discovery, "outputs"), 3);
    // The whole type is read to find one worker's outputs.
    assertEquals(count(discovery, "files_read"), 4);
    assert(
      attribute(discovery, "swamp.diagnostic.read_work_ms")?.doubleValue !==
          undefined ||
        attribute(discovery, "swamp.diagnostic.read_work_ms")?.intValue !==
          undefined,
    );
    assertEquals(count(under("output_removal", deleted)[0], "deleted"), 3);
    const dataRemoval = under("data_removal", deleted)[0];
    assertEquals(count(dataRemoval, "live_deleted"), 2);
    assertEquals(count(dataRemoval, "versions_removed"), 2);
    for (const work of ["file_remove", "catalog_update", "change_stage"]) {
      assert(
        attribute(dataRemoval, `swamp.diagnostic.${work}_work_ms`),
        work,
      );
    }

    assertEquals(count(cleanup, "affected_tokens"), 1);
    assertEquals(count(cleanup, "bindings_pruned"), 1);
    assertEquals(str(cleanup, "swamp.diagnostic.result"), "completed");

    // Bounded strings and counts only: no name, token or path on a phase.
    for (
      const span of spans.filter((s) => s.name.startsWith("swamp.diagnostic."))
    ) {
      assertEquals(str(span, "swamp.diagnostic.area"), "worker_delete");
      for (const { key, value } of span.attributes) {
        const text = value.stringValue ?? "";
        for (const secret of ["pool-", TOKEN, fixture.repoDir]) {
          assert(!text.includes(secret), `${span.name} ${key}=${text}`);
        }
      }
    }
  });
});

Deno.test("worker prune: the span count does not grow with a worker's outputs or data", async () => {
  // One fixture per size, so the two prunes see the same repo shape apart
  // from the worker's own records.
  const pruneOne = (data: number, outputs: number) =>
    withPruneFixture(async (fixture) => {
      await fixture.addWorker({
        name: "pool-one",
        disconnectedMsAgo: 2 * DAY_MS,
        data,
        outputs,
      });
      await collect(prune(fixture.pruneDeps()));
    });
  const small = await withExportedSpans(() => pruneOne(1, 1));
  const large = await withExportedSpans(() => pruneOne(10, 25));

  const names = (spans: OtlpSpan[]) => spans.map((s) => s.name).sort();
  assertEquals(names(large), names(small));
  assertEquals(
    count(only(small, "swamp.diagnostic.output_removal"), "deleted"),
    1,
  );
  assertEquals(
    count(only(large, "swamp.diagnostic.output_removal"), "deleted"),
    25,
  );
  assertEquals(
    count(only(large, "swamp.diagnostic.data_removal"), "live_deleted"),
    10,
  );
});

Deno.test("worker prune: a consumer that stops part way leaves its open phases exported as cancelled", async () => {
  await withPruneFixture(async (fixture) => {
    await fixture.addWorker({
      name: "pool-a",
      disconnectedMsAgo: 2 * DAY_MS,
      outputs: 1,
    });
    await fixture.addWorker({
      name: "pool-b",
      disconnectedMsAgo: 2 * DAY_MS,
      outputs: 1,
    });

    const spans = await withExportedSpans(async () => {
      for await (const event of prune(fixture.pruneDeps())) {
        if (event.kind === "worker_deleted") break;
      }
    });

    const loop = only(spans, "swamp.diagnostic.delete_loop");
    assertEquals(str(loop, "swamp.outcome"), "cancelled");
    assertEquals(loop.status?.code, 2);
    assertEquals(count(loop, "attempted"), 1);
    assertEquals(count(loop, "deleted"), 1);
    const pass = only(spans, "swamp.diagnostic.prune_pass");
    assertEquals(str(pass, "swamp.outcome"), "cancelled");
    // The worker deleted before the stop finished its own delete.
    assertEquals(
      str(only(spans, "swamp.diagnostic.model_delete"), "swamp.outcome"),
      "ok",
    );
    assertEquals(phases(spans, "binding_cleanup").length, 0);
    // The second worker was never touched.
    assertEquals(
      (await fixture.pruneDeps().listWorkers()).map((w) => w.name),
      ["pool-b"],
    );
  });
});
