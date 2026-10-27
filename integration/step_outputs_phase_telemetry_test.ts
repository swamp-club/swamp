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
 * swamp-club#4002: run-detail output resolution exports its phases through
 * the real OTLP exporter, with parentage, value types and outcomes intact.
 * Wires a real repo, serve's definition index, policy authorization and the
 * real `workflow.history.get` handler; spans are exported over HTTP to a
 * port-0 collector (design/enablers/serve-phase-telemetry.md).
 */

import { assert, assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createCatalogStore,
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import type { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { DefinitionIdIndex } from "../src/infrastructure/persistence/definition_id_index.ts";
import { statRecord } from "../src/infrastructure/persistence/workflow_run_index.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import type { Principal } from "../src/domain/access/principal.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import { handleWorkflowHistoryGet } from "../src/serve/handlers/workflow_handlers.ts";
import { FetchOtlpExporter } from "../src/infrastructure/tracing/fetch_otlp_exporter.ts";
import {
  installExecutionObserver,
  uninstallExecutionObserver,
} from "../src/infrastructure/tracing/execution_observer.ts";
import { withRootSpan } from "../src/infrastructure/tracing/mod.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

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
  links?: { traceId: string; spanId: string }[];
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

const MODEL_TYPE = ModelType.create("command/shell");
const WRITER_ID = crypto.randomUUID();
const SECRETS_ID = crypto.randomUUID();
/** Markers that must never reach an exported attribute. */
const CONTENT_MARKER = "content-marker-4002";
const SECRET_MARKER = "secret-marker-4002";

const principal: Principal = { kind: "user", id: "reader" };

function readGrant(id: string, kind: string, pattern: string): Grant {
  return {
    id,
    effect: "allow",
    state: "active",
    source: "method",
    subject: { kind: "user", name: "reader" },
    actions: ["read"],
    resource: { kind, pattern },
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  } as Grant;
}

function resource(name: string, modelId: string, modelName: string) {
  return {
    id: `data-${name}`,
    name,
    version: 1,
    modelType: MODEL_TYPE.normalized,
    modelId,
    modelName,
    specName: "result",
    contentType: "application/json",
    tags: {},
    attributes: null,
    content: null,
  };
}

interface Fixture {
  dir: string;
  repoContext: RepositoryContext;
  /** Reads of definition files through the index, listing and lookups. */
  reads: { count: number; onRead?: (count: number) => void };
  /**
   * When set, a directory's definition files are read only once this many
   * checks have stat'ed it, so overlapping requests share its listing.
   */
  holdReadsUntilStats?: number;
  ctx: ConnectionContext;
}

/**
 * A repo whose `history-wf` run has a step that wrote resources owned by
 * `writer` (readable) and `secrets` (not), some missing or unparseable, a
 * step that ran `child-wf`, and a step whose child run is gone. The
 * principal may read both workflows and `writer`'s data.
 */
async function withFixture(
  options: { unrelated?: number; extraOutputs?: number },
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-4002-" });
  let repoContext: RepositoryContext | undefined;
  try {
    repoContext = createRepositoryContext({ repoDir: dir });
    const definitions = repoContext
      .definitionRepo as unknown as YamlDefinitionRepository;
    const definitionOf = (id: string, name: string) =>
      Definition.fromData({ ...Definition.create({ name }).toData(), id });
    await definitions.save(MODEL_TYPE, definitionOf(WRITER_ID, "writer"));
    await definitions.save(MODEL_TYPE, definitionOf(SECRETS_ID, "secrets"));
    for (let i = 0; i < (options.unrelated ?? 0); i++) {
      await definitions.save(
        MODEL_TYPE,
        definitionOf(crypto.randomUUID(), `unrelated-${i}`),
      );
    }

    const child = Workflow.create({
      name: "child-wf",
      jobs: [Job.create({
        name: "main",
        steps: [Step.create({
          name: "write",
          task: StepTask.model("writer", "execute"),
        })],
      })],
    });
    const parent = Workflow.create({
      name: "history-wf",
      jobs: [Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "write",
            task: StepTask.model("writer", "execute"),
          }),
          Step.create({ name: "child", task: StepTask.workflow("child-wf") }),
          Step.create({ name: "gone", task: StepTask.workflow("child-wf") }),
        ],
      })],
    });
    await repoContext.workflowRepo.save(child);
    await repoContext.workflowRepo.save(parent);

    const runRepo = new YamlWorkflowRunRepository(dir);
    const childRun = WorkflowRun.create(child);
    childRun.start();
    childRun.getJob("main")!.start();
    const childStep = childRun.getJob("main")!.getStep("write")!;
    childStep.start();
    childStep.succeed({
      type: "model_method",
      model: "writer",
      method: "execute",
      resources: {
        result: { child: resource("child-record", WRITER_ID, "writer") },
      },
    });
    childRun.getJob("main")!.succeed();
    childRun.complete();
    await runRepo.save(child.id, childRun);

    const extra = Array.from(
      { length: options.extraOutputs ?? 0 },
      (_, i) => `extra-${i}`,
    );
    const run = WorkflowRun.create(parent);
    run.start();
    const job = run.getJob("main")!;
    job.start();
    const write = job.getStep("write")!;
    write.start();
    write.succeed({
      type: "model_method",
      model: "writer",
      method: "execute",
      resources: {
        result: Object.fromEntries([
          ["record", resource("record", WRITER_ID, "writer")],
          ["token", resource("token", SECRETS_ID, "secrets")],
          ["missing", resource("missing", WRITER_ID, "writer")],
          ["broken", resource("broken", WRITER_ID, "writer")],
          ["list", resource("list", WRITER_ID, "writer")],
          ...extra.map((name) => [name, resource(name, WRITER_ID, "writer")]),
        ]),
      },
    });
    for (
      const [name, runId] of [
        ["child", childRun.id],
        ["gone", crypto.randomUUID()],
      ]
    ) {
      const step = job.getStep(name)!;
      step.start();
      step.succeed({ type: "workflow", workflowId: child.id, runId });
    }
    job.succeed();
    run.complete();
    await runRepo.save(parent.id, run);

    const catalogStore = createCatalogStore(dir);
    try {
      const dataRepo = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        catalogStore,
      );
      const contents: Array<[string, string, string]> = [
        [WRITER_ID, "record", JSON.stringify({ stdout: CONTENT_MARKER })],
        [WRITER_ID, "child-record", JSON.stringify({ stdout: "from-child" })],
        [SECRETS_ID, "token", JSON.stringify({ apiKey: SECRET_MARKER })],
        [WRITER_ID, "broken", "{not json"],
        [WRITER_ID, "list", "[1,2]"],
        ...extra.map((name): [string, string, string] => [
          WRITER_ID,
          name,
          JSON.stringify({ [name]: true }),
        ]),
      ];
      for (const [modelId, name, text] of contents) {
        const path = dataRepo.getContentPath(MODEL_TYPE, modelId, name, 1);
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(path, text);
      }
    } finally {
      catalogStore.close();
    }

    const reads: Fixture["reads"] = { count: 0 };
    const stats = new Map<string, number>();
    const statWaiters: Array<() => void> = [];
    const fixture = {} as Fixture;
    const held = (path: string) =>
      (stats.get(dirname(path)) ?? 0) >= (fixture.holdReadsUntilStats ?? 0);
    const grants = [
      readGrant("wf", "workflow", "history-wf"),
      readGrant("child-wf", "workflow", "child-wf"),
      readGrant("data", "data", "writer"),
    ];
    const snapshot = new PolicySnapshot(grants, []);
    const ctx = {
      repoDir: dir,
      repoContext,
      authConfig: {
        mode: "token",
        admins: [],
        allowedCollectives: [],
        allowedUsers: [],
        oauthProvider: "",
        groupsField: "",
        restrictedModelTypes: [],
        restrictedCommands: [],
        approveRequiresExplicitGrant: false,
        signalRequiresExplicitGrant: false,
        tagRequiresExplicitGrant: false,
      },
      policySnapshotLoader: {
        snapshot,
        decisionService: new GrantBasedAccessDecisionService(snapshot),
      } as unknown as PolicySnapshotLoader,
      definitionIndex: new DefinitionIdIndex({
        definitionRoots: () => definitions.definitionRoots(),
        readDefinitionFile: async (path, segments, isSymlink) => {
          while (!held(path)) {
            await new Promise<void>((resolve) => statWaiters.push(resolve));
          }
          reads.count++;
          reads.onRead?.(reads.count);
          return await definitions.readDefinitionFile(
            path,
            segments,
            isSymlink,
          );
        },
      }, {
        // Every stat the fixture's writes set is old enough to trust.
        now: () => Date.now() + 60_000,
        stat: async (path) => {
          const found = await statRecord(path);
          stats.set(path, (stats.get(path) ?? 0) + 1);
          for (const wake of statWaiters.splice(0)) wake();
          return found;
        },
      }),
    } as unknown as ConnectionContext;
    Object.assign(fixture, { dir, repoContext, reads, ctx });
    await fn(fixture);
  } finally {
    repoContext?.catalogStore.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

interface Frame {
  type: string;
  payload?: {
    data: {
      jobs: Array<{
        steps: Array<{ name: string; outputs?: Record<string, unknown> }>;
      }>;
    };
  };
  error?: { code: string };
}

/** One `workflow.history.get` under its own root span. */
async function historyGet(
  fixture: Fixture,
  controller = new AbortController(),
): Promise<Frame> {
  const frames: Frame[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => frames.push(JSON.parse(data)),
  } as unknown as WebSocket;
  await withRootSpan(
    "test.history_request",
    {},
    () =>
      handleWorkflowHistoryGet(
        socket,
        fixture.ctx,
        crypto.randomUUID(),
        { workflowIdOrName: "history-wf" },
        controller,
        principal,
      ),
  );
  assertEquals(frames.length, 1);
  return frames[0];
}

function attribute(span: OtlpSpan, key: string): OtlpValue | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

function str(span: OtlpSpan, key: string): string | undefined {
  return attribute(span, key)?.stringValue;
}

/** A counter: exported as an OTLP integer. */
function int(span: OtlpSpan, key: string): number | undefined {
  const value = attribute(span, key);
  if (value === undefined) return undefined;
  assert(value.intValue !== undefined, `${key} is an integer`);
  return Number(value.intValue);
}

/** A duration or work total: exported as an OTLP number. */
function ms(span: OtlpSpan, key: string): number {
  const value = attribute(span, key);
  const n = value?.doubleValue ??
    (value?.intValue !== undefined ? Number(value.intValue) : undefined);
  assert(typeof n === "number" && n >= 0, `${key} is a non-negative number`);
  return n;
}

/** Spans of each request, by its root span, in export order. */
function requests(spans: OtlpSpan[]): OtlpSpan[][] {
  return spans.filter((s) => s.name === "test.history_request").map((root) =>
    spans.filter((s) => s.traceId === root.traceId)
  );
}

function only(spans: OtlpSpan[], name: string): OtlpSpan {
  const found = spans.filter((s) => s.name === name);
  assertEquals(found.length, 1, `one ${name}`);
  return found[0];
}

function phase(spans: OtlpSpan[], name: string): OtlpSpan {
  return only(spans, `swamp.diagnostic.${name}`);
}

function stepOutputs(frame: Frame, step: string) {
  return frame.payload!.data.jobs[0].steps.find((s) => s.name === step)!
    .outputs;
}

/** The definition files the fixture saves: writer, secrets and unrelated. */
const definitionFiles = (unrelated: number) => 2 + unrelated;

Deno.test("step_outputs phases: a request exports catalog_open, output_walk and owner_index through OTLP with parentage, counts and value types", async () => {
  await withFixture({ unrelated: 3 }, async (fixture) => {
    let frame: Frame | undefined;
    const spans = await withExportedSpans(async () => {
      frame = await historyGet(fixture);
    });
    assertEquals(frame!.type, "workflow.history.get");
    assertEquals(stepOutputs(frame!, "write"), { stdout: CONTENT_MARKER });
    assertEquals(stepOutputs(frame!, "child"), {
      write: { stdout: "from-child" },
    });

    const [request] = requests(spans);
    const history = only(request, "swamp.workflow.history.get");
    const resolve = only(request, "swamp.workflow.step_outputs.resolve");
    const opening = phase(request, "catalog_open");
    const walk = phase(request, "output_walk");
    const index = phase(request, "owner_index");
    const validate = only(request, "swamp.serve.definition_index.validate");
    assertEquals(resolve.parentSpanId, history.spanId);
    assertEquals(opening.parentSpanId, resolve.spanId);
    assertEquals(walk.parentSpanId, resolve.spanId);
    assertEquals(index.parentSpanId, walk.spanId);
    assertEquals(validate.parentSpanId, index.spanId);

    for (const span of [opening, walk, index]) {
      assertEquals(str(span, "swamp.diagnostic.area"), "step_outputs");
      assertEquals(str(span, "swamp.outcome"), "ok");
      assertEquals(span.status?.code, 1);
      assertEquals(attribute(span, "swamp.diagnostic.cancel_observed"), {
        boolValue: false,
      });
      ms(span, "swamp.phase.local_ms");
    }
    assertEquals(str(walk, "swamp.diagnostic.phase"), "output_walk");
    assertEquals(str(walk, "swamp.diagnostic.result"), "completed");

    // record, missing, broken and list in the step, and the child's record:
    // five allowed; the secrets token denied and never read.
    assertEquals(
      Object.fromEntries(
        [
          "resources_attempted",
          "authorize_allowed",
          "authorize_denied",
          "authorize_errors",
          "reads_succeeded",
          "reads_missing",
          "reads_failed",
          "parse_failed",
          "parse_not_object",
          "child_run_lookups",
          "child_runs_unique",
          "child_runs_missing",
          "owner_lookups",
          "owner_lookups_reused",
        ].map((key) => [key, int(walk, `swamp.diagnostic.${key}`)]),
      ),
      {
        resources_attempted: 5,
        authorize_allowed: 5,
        authorize_denied: 1,
        authorize_errors: 0,
        // A read that returned content; parsing is counted apart.
        reads_succeeded: 4,
        reads_missing: 1,
        reads_failed: 0,
        parse_failed: 1,
        parse_not_object: 1,
        child_run_lookups: 2,
        child_runs_unique: 2,
        child_runs_missing: 1,
        // Six decisions over two owners.
        owner_lookups: 6,
        owner_lookups_reused: 4,
      },
    );
    assert(int(walk, "swamp.diagnostic.content_bytes")! > 0);
    for (
      const work of [
        "authorize",
        "owner_lookup",
        "content_read",
        "json_parse",
        "child_run_lookup",
        "assemble",
      ]
    ) {
      ms(walk, `swamp.diagnostic.${work}_work_ms`);
    }
    // The existing counters keep their meaning.
    assertEquals(int(resolve, "step_outputs.resources_read"), 5);
    assertEquals(int(resolve, "step_outputs.resources_denied"), 1);
    assertEquals(int(resolve, "step_outputs.child_runs_read"), 2);

    assertEquals(str(index, "swamp.diagnostic.cache"), "cold");
    assertEquals(
      int(index, "swamp.diagnostic.files_parsed"),
      definitionFiles(3),
    );
    assertEquals(int(index, "swamp.diagnostic.files_joined"), 0);
    assertEquals(
      int(index, "swamp.diagnostic.definitions"),
      definitionFiles(3),
    );

    // Nothing exported names a path, a definition, or content.
    for (const span of request) {
      if (!span.name.startsWith("swamp.diagnostic.")) continue;
      for (const { value } of span.attributes) {
        const text = String(value.stringValue ?? "");
        for (
          const secret of [
            fixture.dir,
            CONTENT_MARKER,
            SECRET_MARKER,
            "writer",
            "secrets",
          ]
        ) {
          assert(!text.includes(secret), `${span.name} leaks ${secret}`);
        }
      }
    }

    // The next request finds the index warm.
    const again = await withExportedSpans(async () => {
      await historyGet(fixture);
    });
    const warm = phase(requests(again)[0], "owner_index");
    assertEquals(str(warm, "swamp.diagnostic.cache"), "warm");
    assertEquals(int(warm, "swamp.diagnostic.files_parsed"), 0);
  });
});

Deno.test("step_outputs phases: two requests sharing one owner index listing parse it once, and the joiner links to the request that ran it", async () => {
  await withFixture({ unrelated: 4 }, async (fixture) => {
    // Each directory's files are read only once both checks stat'ed it.
    fixture.holdReadsUntilStats = 2;
    const spans = await withExportedSpans(async () => {
      const frames = await Promise.all([
        historyGet(fixture),
        historyGet(fixture),
      ]);
      for (const frame of frames) {
        assertEquals(stepOutputs(frame, "write"), { stdout: CONTENT_MARKER });
      }
    });
    const traces = requests(spans);
    assertEquals(traces.length, 2);
    const indexes = traces.map((t) => phase(t, "owner_index"));
    const validates = traces.map((t) =>
      only(t, "swamp.serve.definition_index.validate")
    );
    // Each file was parsed by exactly one request.
    assertEquals(
      indexes.reduce(
        (sum, span) =>
          sum + int(span, "swamp.diagnostic.files_parsed")! -
          int(span, "swamp.diagnostic.files_joined")!,
        0,
      ),
      definitionFiles(4),
    );
    const joined = indexes
      .map((span, i) => ({ span, i }))
      .filter(({ span }) => int(span, "swamp.diagnostic.dirs_joined")! > 0);
    assert(joined.length > 0, "a request joined the other's listing");
    for (const { i } of joined) {
      const other = validates[1 - i];
      assertEquals(
        validates[i].links?.map((l) => [l.traceId, l.spanId]),
        [[other.traceId, other.spanId]],
      );
      // The joined listing stays under the request that ran it.
      assertEquals(validates[i].traceId, traces[i][0].traceId);
    }
  });
});

Deno.test("step_outputs phases: a request cancelled mid-walk ends cancelled with the counts it reached", async () => {
  await withFixture({ unrelated: 1 }, async (fixture) => {
    const controller = new AbortController();
    // The listing reads every file; the next reads are the owners' own:
    // writer's for the record, then secrets' for the token.
    fixture.reads.onRead = (count) => {
      if (count === definitionFiles(1) + 2) controller.abort();
    };
    let frame: Frame | undefined;
    const spans = await withExportedSpans(async () => {
      frame = await historyGet(fixture, controller);
    });
    assertEquals(frame!.error?.code, "cancelled");
    const [request] = requests(spans);
    const walk = phase(request, "output_walk");
    assertEquals(str(walk, "swamp.outcome"), "cancelled");
    assertEquals(walk.status?.code, 2);
    assertEquals(str(walk, "swamp.diagnostic.result"), "partial");
    assertEquals(attribute(walk, "swamp.diagnostic.cancel_observed"), {
      boolValue: true,
    });
    assertEquals(int(walk, "swamp.diagnostic.resources_attempted"), 1);
    assertEquals(int(walk, "swamp.diagnostic.reads_succeeded"), 1);
    assertEquals(int(walk, "swamp.diagnostic.authorize_allowed"), 1);
    assertEquals(int(walk, "swamp.diagnostic.authorize_errors"), 0);
    assertEquals(
      int(
        only(request, "swamp.workflow.step_outputs.resolve"),
        "step_outputs.resources_read",
      ),
      1,
    );
  });
});

Deno.test("step_outputs phases: a request cancelled before it starts and one whose owner lookup fails stay queryable", async () => {
  await withFixture({}, async (fixture) => {
    const cancelled = new AbortController();
    cancelled.abort();
    const failing = { armed: false };
    fixture.reads.onRead = () => {
      if (failing.armed) throw new Error("definition store unavailable");
    };
    const frames: Frame[] = [];
    const spans = await withExportedSpans(async () => {
      frames.push(await historyGet(fixture, cancelled));
      // Warm the index, then fail the first owner read of the next request.
      frames.push(await historyGet(fixture));
      failing.armed = true;
      frames.push(await historyGet(fixture));
    });
    assertEquals(frames.map((f) => f.error?.code), [
      "cancelled",
      undefined,
      "workflow_history_get_failed",
    ]);
    const [before, , failed] = requests(spans);
    const cancelledWalk = phase(before, "output_walk");
    assertEquals(str(cancelledWalk, "swamp.outcome"), "cancelled");
    assertEquals(int(cancelledWalk, "swamp.diagnostic.resources_attempted"), 0);
    assertEquals(
      before.filter((s) => s.name === "swamp.diagnostic.owner_index"),
      [],
    );
    const failedWalk = phase(failed, "output_walk");
    assertEquals(str(failedWalk, "swamp.outcome"), "error");
    assertEquals(str(failedWalk, "swamp.diagnostic.result"), "partial");
    assertEquals(int(failedWalk, "swamp.diagnostic.authorize_errors"), 1);
  });
});

Deno.test("step_outputs phases: a request's span count does not grow with the definition catalog or the number of outputs", async () => {
  const countFor = async (unrelated: number, extraOutputs: number) => {
    let count = 0;
    await withFixture({ unrelated, extraOutputs }, async (fixture) => {
      const spans = await withExportedSpans(async () => {
        await historyGet(fixture);
      });
      count = requests(spans)[0].length;
    });
    return count;
  };
  const small = await countFor(2, 0);
  assertEquals(await countFor(200, 0), small);
  assertEquals(await countFor(2, 40), small);
});

Deno.test("step_outputs phases: with tracing off a request answers exactly as with it on", async () => {
  await withFixture({ unrelated: 2 }, async (fixture) => {
    const untraced = await historyGet(fixture);
    let traced: Frame | undefined;
    await withExportedSpans(async () => {
      traced = await historyGet(fixture);
    });
    assertEquals(traced!.payload, untraced.payload);
    assert(untraced.payload);
  });
});
