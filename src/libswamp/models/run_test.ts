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

import { SENSITIVE_FORMAT_VERSION } from "../../domain/secrets/persisted_sensitive_form.ts";
import type { WrittenVersion } from "../../domain/datastore/datastore_sync_service.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  messageFor,
  wordedText,
  wordedUserError,
} from "../../domain/behavior_wording.ts";
import {
  methodExecutionFailed,
  modelMethodRun,
  type ModelMethodRunDeps,
  type ModelMethodRunEvent,
  type ModelMethodRunInput,
  modelNotFound,
  noEvaluatedDefinition,
  unknownMethod,
  unknownModelType,
} from "./run.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { ModelDefinition } from "../../domain/models/model.ts";
import { z } from "zod";
import { RunSensitiveValues } from "../../domain/secrets/run_sensitive_values.ts";
import { VaultSecretBag } from "../../domain/vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../../domain/vaults/secret_bag_registry.ts";
import { SecretLoader } from "../../domain/vaults/secret_loader.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import { SecretRedactor } from "../../domain/secrets/secret_redactor.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import type { ModelUpdated } from "../../domain/events/types.ts";
import type { DataHandle } from "../../domain/models/model.ts";
import { generateDataId } from "../../domain/data/data_id.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import type { ActiveRun } from "../../domain/models/active_run.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import type { ModelOutput } from "../../domain/models/model_output.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import { typedStagers } from "../../infrastructure/persistence/unit_of_work_binding.ts";
import { errorPaths, markErrorPaths } from "../../domain/errors.ts";

await initializeLogging({});

// --- Test helpers ---

const TEST_MODEL_TYPE = ModelType.create("test/model");

function createTestDefinition(
  name: string,
  methodName: string,
): Definition {
  return Definition.create({
    name,
    methods: {
      [methodName]: {
        arguments: { key: "value" },
      },
    },
  });
}

function createTestModelDef(methodName: string): ModelDefinition {
  return {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    methods: {
      [methodName]: {
        description: "Test method",
        arguments: z.object({
          key: z.string().optional(),
        }),
        execute: (_args, _ctx) => {
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
}

// deno-lint-ignore no-explicit-any
function createFakeOutputRepo(): any {
  return {
    save: () => Promise.resolve(),
    findById: () => Promise.resolve(null),
    findByDefinitionId: () => Promise.resolve([]),
    findByMethodName: () => Promise.resolve([]),
    findAll: () => Promise.resolve([]),
  };
}

function createFakeDataRepo(gcResult?: {
  versionsRemoved: number;
  bytesReclaimed: number;
  // deno-lint-ignore no-explicit-any
}): any {
  return {
    nextId: () => crypto.randomUUID(),
    getPath: (
      _type: ModelType,
      _modelId: string,
      dataName: string,
      version: number,
    ) => `/data/${dataName}/v${version}`,
    getContent: () => Promise.resolve(null),
    findAllForModel: () => Promise.resolve([]),
    save: () => Promise.resolve({ version: 1 }),
    collectGarbage: () =>
      Promise.resolve(
        gcResult ?? { versionsRemoved: 0, bytesReclaimed: 0 },
      ),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeDefinitionRepo(): any {
  return {
    findByNameGlobal: () => Promise.resolve(null),
    findById: () => Promise.resolve(null),
    save: () => Promise.resolve(),
  };
}

// deno-lint-ignore no-explicit-any
function createFakeEvaluationService(): any {
  return {
    hasDefinitionExpressions: () => false,
    buildRuntimeContext: (_def: Definition, inputs?: Record<string, unknown>) =>
      Promise.resolve({ model: {}, env: {}, inputs }),
    evaluateDefinition: (def: Definition) =>
      Promise.resolve({
        definition: def,
        type: TEST_MODEL_TYPE,
        hadExpressions: false,
      }),
    resolveRuntimeExpressionsInDefinition: (def: Definition) =>
      Promise.resolve({
        definition: def,
        secretBag: new VaultSecretBag(new SecretBagRegistry()),
      }),
    resolveRuntimeExpressionsInData: (data: unknown) => Promise.resolve(data),
    // The fake execution service delivers nothing, so nothing is loaded.
    secretLoader: () =>
      new SecretLoader(() => Promise.resolve(new VaultService())),
  };
}

/** What the real service does once the arguments pass: the caller's hook. */
async function validatedArguments(
  options?: { onArgumentsValidated?: () => Promise<void> },
): Promise<void> {
  await options?.onArgumentsValidated?.();
}

// deno-lint-ignore no-explicit-any
function createFakeExecutionService(): any {
  return {
    executeWorkflow: async (
      _definition: unknown,
      _modelDef: unknown,
      _methodName: string,
      _context: unknown,
      options?: { onArgumentsValidated?: () => Promise<void> },
    ) => {
      await validatedArguments(options);
      return { dataHandles: [] };
    },
  };
}

// deno-lint-ignore no-explicit-any
function createFakeVaultService(): any {
  return {};
}

// deno-lint-ignore no-explicit-any
function createFakeRedactor(): any {
  return {};
}

function createTestDeps(
  definition: Definition | null,
  modelDef: ModelDefinition | undefined,
): ModelMethodRunDeps {
  return {
    repoDir: "/tmp/test",
    lookupDefinition: (_idOrName) =>
      Promise.resolve(
        definition ? { definition, type: TEST_MODEL_TYPE } : null,
      ),
    getModelDef: (_type) => modelDef,
    createEvaluationService: () => createFakeEvaluationService(),
    loadEvaluatedDefinition: () => Promise.resolve(null),
    saveEvaluatedDefinition: () => Promise.resolve(),
    createExecutionService: () => createFakeExecutionService(),
    createVaultService: () => Promise.resolve(createFakeVaultService()),
    dataRepo: createFakeDataRepo(),
    definitionRepo: createFakeDefinitionRepo(),
    outputRepo: createFakeOutputRepo(),
    dataQueryService: {
      query: () => Promise.resolve([]),
    } as unknown as DataQueryService,
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: createFakeRedactor(),
        cleanup: () => {},
      }),
  };
}

function createTestInput(
  modelIdOrName: string,
  methodName: string,
): ModelMethodRunInput {
  return {
    modelIdOrName,
    methodName,
    inputs: {},
    lastEvaluated: false,
  };
}

// --- Tests ---

Deno.test("modelMethodRun yields validating_inputs and resolving_model prefix events", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  assertEquals(events[0].kind, "validating_inputs");
  assertEquals(events[1].kind, "resolving_model");
  if (events[1].kind === "resolving_model") {
    assertEquals(events[1].modelIdOrName, "test-model");
  }
});

Deno.test("modelMethodRun yields error for missing model", async () => {
  const deps = createTestDeps(null, undefined);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("nonexistent", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "model_not_found");
  }
});

Deno.test("modelMethodRun yields error for unknown model type", async () => {
  const definition = createTestDefinition("test-model", "run");
  const deps = createTestDeps(definition, undefined);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "unknown_model_type");
  }
});

Deno.test("modelMethodRun yields error for unknown method", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "nonexistent")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "unknown_method");
  }
});

Deno.test("modelMethodRun yields error for missing evaluated definition with --last-evaluated", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      ...createTestInput("test-model", "run"),
      lastEvaluated: true,
    }),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "no_evaluated_definition");
  }
});

Deno.test("modelMethodRun happy path yields model_resolved, evaluating, executing, completed", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const kinds = events.map((e) => e.kind);
  assertEquals(kinds.includes("validating_inputs"), true);
  assertEquals(kinds.includes("resolving_model"), true);
  assertEquals(kinds.includes("model_resolved"), true);
  assertEquals(kinds.includes("evaluating_expressions"), true);
  assertEquals(kinds.includes("executing"), true);
  assertEquals(kinds.includes("completed"), true);

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.modelName, "test-model");
    assertEquals(completed.run.methodName, "run");
    assertEquals(completed.run.status, "succeeded");
    assertEquals(completed.run.modelType, "test/model");
  }
});

/** A tracker that records the rows a run registers. */
function createRecordingTracker(registrations: ActiveRun[]) {
  return {
    register: (run: ActiveRun) => {
      registrations.push(run);
    },
    heartbeat: () => {},
    complete: () => {},
  } as unknown as RunTrackerRepository;
}

Deno.test("modelMethodRun: registers its tracker row with the serve instance running it (swamp-club#2914)", async () => {
  const registrations: ActiveRun[] = [];
  const deps = {
    ...createTestDeps(
      createTestDefinition("test-model", "run"),
      createTestModelDef("run"),
    ),
    runTracker: createRecordingTracker(registrations),
  };
  await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("test-model", "run"),
      instanceId: "serve-instance",
    }),
  );

  assertEquals(registrations.map((r) => r.instanceId), ["serve-instance"]);
});

Deno.test("modelMethodRun: registers its tracker row with no instance id outside serve", async () => {
  const registrations: ActiveRun[] = [];
  const deps = {
    ...createTestDeps(
      createTestDefinition("test-model", "run"),
      createTestModelDef("run"),
    ),
    runTracker: createRecordingTracker(registrations),
  };
  await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("test-model", "run"),
    ),
  );

  assertEquals(registrations.map((r) => r.instanceId), [undefined]);
});

// deno-lint-ignore no-explicit-any
function createFailingExecutionService(error: Error): any {
  return { executeWorkflow: () => Promise.reject(error) };
}

Deno.test("modelMethodRun yields error on execution failure", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(new Error("execution boom")),
    outputRepo: createFakeOutputRepo(),
  };
  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "method_execution_failed");
  }
});

Deno.test("modelMethodRun: the failed method summary lists data the method wrote before failing", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const error = new Error("execution boom") as Error & {
    dataHandles?: DataHandle[];
  };
  error.dataHandles = [
    {
      dataId: generateDataId(),
      name: "partial-state",
      specName: "state",
      kind: "resource" as const,
      version: 1,
      size: 42,
      tags: {},
      metadata: { contentType: "application/json" },
    } as DataHandle,
  ];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () => createFailingExecutionService(error),
    outputRepo: createFakeOutputRepo(),
  };
  const events = await collect<ModelMethodRunEvent>(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("test-model", "run"),
    ),
  );

  const summary = events.find((e) =>
    e.kind === "report_completed" && e.reportName === "@swamp/method-summary"
  );
  if (summary?.kind !== "report_completed") {
    throw new Error("expected a completed method-summary report");
  }
  assertStringIncludes(summary.markdown, "partial-state");
  assertEquals(summary.markdown.includes("No data output."), false);
  assertEquals(events[events.length - 1].kind, "error");
});

function methodSummaryProvenance(
  events: ModelMethodRunEvent[],
): Record<string, unknown> {
  const summary = events.find((e) =>
    e.kind === "report_completed" && e.reportName === "@swamp/method-summary"
  );
  if (summary?.kind !== "report_completed") {
    throw new Error("expected a completed method-summary report");
  }
  return summary.json.provenance as Record<string, unknown>;
}

Deno.test("modelMethodRun: the method summary carries the run's provenance on success and failure (swamp-club#3722)", async () => {
  const modelDef = createTestModelDef("run");
  const input = {
    ...createTestInput("test-model", "run"),
    initiatedBy: "user:alice",
  };

  const succeeded = await collect<ModelMethodRunEvent>(
    modelMethodRun(
      createLibSwampContext(),
      createTestDeps(createTestDefinition("test-model", "run"), modelDef),
      input,
    ),
  );
  const failed = await collect<ModelMethodRunEvent>(
    modelMethodRun(
      createLibSwampContext(),
      {
        ...createTestDeps(createTestDefinition("test-model", "run"), modelDef),
        createExecutionService: () =>
          createFailingExecutionService(new Error("execution boom")),
      },
      input,
    ),
  );

  for (const events of [succeeded, failed]) {
    const provenance = methodSummaryProvenance(events);
    assertEquals(provenance.triggeredBy, "manual");
    assertEquals(provenance.initiatedBy, "user:alice");
    assertEquals(provenance.modelVersion, "1.0.0");
    assertEquals(typeof provenance.definitionHash, "string");
  }
  assertEquals(failed.at(-1)?.kind, "error");
});

Deno.test("modelMethodRun: an edited definition changes the method summary's definition hash (swamp-club#3722)", async () => {
  const modelDef = createTestModelDef("run");
  const before = createTestDefinition("test-model", "run");
  const after = Definition.create({
    name: "test-model",
    methods: { run: { arguments: { key: "edited" } } },
  });

  const hashes: unknown[] = [];
  for (const definition of [before, after]) {
    const events = await collect<ModelMethodRunEvent>(
      modelMethodRun(
        createLibSwampContext(),
        createTestDeps(definition, modelDef),
        createTestInput("test-model", "run"),
      ),
    );
    hashes.push(methodSummaryProvenance(events).definitionHash);
  }

  assertEquals(hashes[0], await before.computeHash());
  assertEquals(hashes[1], await after.computeHash());
  assertEquals(hashes[0] === hashes[1], false);
});

Deno.test("modelMethodRun: a different --input leaves the method summary's definition hash unchanged (swamp-club#3722)", async () => {
  const modelDef = createTestModelDef("run");
  const stored = createTestDefinition("test-model", "run").toData();
  const storedHash = await Definition.fromData(stored).computeHash();

  const hashes: unknown[] = [];
  for (const value of ["first", "second"]) {
    // Each run loads the stored definition afresh, as the CLI does.
    const events = await collect<ModelMethodRunEvent>(
      modelMethodRun(
        createLibSwampContext(),
        createTestDeps(Definition.fromData(stored), modelDef),
        { ...createTestInput("test-model", "run"), inputs: { key: value } },
      ),
    );
    hashes.push(methodSummaryProvenance(events).definitionHash);
  }

  assertEquals(hashes, [storedHash, storedHash]);
});

Deno.test("modelMethodRun marks output cancelled on abort", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const controller = new AbortController();
  const savedOutputs: { status: string }[] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(
        new DOMException("The operation was aborted.", "AbortError"),
      ),
    outputRepo: {
      ...createFakeOutputRepo(),
      save: (_type: unknown, _method: unknown, output: unknown) => {
        savedOutputs.push({
          status: (output as { status: string }).status,
        });
        return Promise.resolve();
      },
    } as ReturnType<typeof createFakeOutputRepo>,
  };

  // Abort before execution to simulate cancellation
  controller.abort();
  const ctx = createLibSwampContext({ signal: controller.signal });
  const events = await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  // No error event should be yielded — the output is marked cancelled
  const errorEvents = events.filter((e) => e.kind === "error");
  assertEquals(errorEvents.length, 0);
  // The stream says so itself, so a caller never reads the run as a success
  const cancelledEvents = events.filter((e) => e.kind === "cancelled");
  assertEquals(cancelledEvents.length, 1);
  assertEquals(events.at(-1)?.kind, "cancelled");
  assertEquals(events.some((e) => e.kind === "completed"), false);
  // The output should have been saved as cancelled
  const cancelledSaves = savedOutputs.filter((o) => o.status === "cancelled");
  assertEquals(cancelledSaves.length > 0, true);
});

Deno.test("modelMethodRun: a cancelled run commits its v3 unit and yields the same stream on both layouts (swamp-club#3299)", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(
        new DOMException("The operation was aborted.", "AbortError"),
      ),
  };
  const ends: string[] = [];
  const unit = (typed: boolean): UnitOfWork => {
    const uow: UnitOfWork = {
      stage: () => Promise.resolve(),
      commit: () => {
        ends.push(`${typed ? "v3" : "legacy"} commit`);
        return Promise.resolve();
      },
      abandon: () => {
        ends.push(`${typed ? "v3" : "legacy"} abandon`);
        return Promise.resolve();
      },
      staged: () => [],
    };
    // A unit that takes typed changes is a v3 commit-log unit.
    if (typed) typedStagers.register(uow, () => Promise.resolve());
    return uow;
  };

  const kinds: string[][] = [];
  for (const typed of [true, false]) {
    const controller = new AbortController();
    controller.abort();
    const ctx = createLibSwampContext({
      signal: controller.signal,
      openUnitOfWork: () => unit(typed),
    });
    const events = await collect(
      modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
    );
    kinds.push(events.map((e) => e.kind));
  }

  assertEquals(ends, ["v3 commit", "legacy abandon"]);
  // The stream is the same on both: it ends on the cancelled event
  // (swamp-club#3317), with no error event.
  assertEquals(kinds[0], kinds[1]);
  assertEquals(kinds[0].at(-1), "cancelled");
  assertEquals(kinds[0].includes("error"), false);
});

/**
 * Runs a method that fails once `controller` has aborted, and reports the
 * cancelled output's error message and the reason its tracker row got.
 */
async function cancelledRunRecords(
  controller: AbortController,
): Promise<{ message: string | undefined; reason: string | undefined }> {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const messages: (string | undefined)[] = [];
  const reasons: (string | undefined)[] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(
        new Error("process exited with signal SIGTERM"),
      ),
    outputRepo: {
      ...createFakeOutputRepo(),
      save: (_type: unknown, _method: unknown, output: unknown) => {
        const saved = output as ModelOutput;
        if (saved.status === "cancelled") messages.push(saved.error?.message);
        return Promise.resolve();
      },
    } as ReturnType<typeof createFakeOutputRepo>,
    runTracker: {
      register: () => {},
      heartbeat: () => {},
      complete: (_runId: string, _status: string, reason?: string) => {
        reasons.push(reason);
      },
    } as unknown as RunTrackerRepository,
  };

  await collect(
    modelMethodRun(
      createLibSwampContext({ signal: controller.signal }),
      deps,
      createTestInput("test-model", "run"),
    ),
  );

  assertEquals(messages.length, 1);
  assertEquals(reasons.length, 1);
  return { message: messages[0], reason: reasons[0] };
}

Deno.test("modelMethodRun: a plain abort records aborted and leaves the tracker row's reason unset (swamp-club#2922)", async () => {
  const controller = new AbortController();
  controller.abort();

  assertEquals(await cancelledRunRecords(controller), {
    message: "aborted",
    reason: undefined,
  });
});

Deno.test("modelMethodRun: a timeout records the run cancelled as timed out (swamp-club#2922)", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("Signal timed out.", "TimeoutError"));

  assertEquals(await cancelledRunRecords(controller), {
    message: "timed out",
    reason: "timed out",
  });
});

Deno.test("modelMethodRun: a cancel with a reason records that reason (swamp-club#2922)", async () => {
  const controller = new AbortController();
  controller.abort(new Error("No longer needed"));

  assertEquals(await cancelledRunRecords(controller), {
    message: "No longer needed",
    reason: "No longer needed",
  });
});

Deno.test("modelMethodRun: a timed-out run yields a cancelled event naming the timeout (swamp-club#3317)", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const controller = new AbortController();
  controller.abort(new DOMException("Signal timed out.", "TimeoutError"));
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      createFailingExecutionService(controller.signal.reason),
  };

  const events = await collect(
    modelMethodRun(
      createLibSwampContext({ signal: controller.signal }),
      deps,
      createTestInput("test-model", "run"),
    ),
  );

  const last = events.at(-1);
  assertEquals(last?.kind, "cancelled");
  if (last?.kind === "cancelled") {
    assertEquals(last.reason, "timed out");
    assertEquals(last.run.status, "cancelled");
    assertEquals(last.run.modelName, "test-model");
    assertEquals(last.run.methodName, "run");
    assertEquals(last.run.dataArtifacts, []);
  }
});

// --- Error factory tests ---

Deno.test("modelNotFound returns correct error", () => {
  const error = modelNotFound("my-model");
  assertEquals(error.code, "model_not_found");
  assertEquals(error.message, "Behavior not found: my-model");
  assertEquals(messageFor(error, "model"), "Model not found: my-model");
});

Deno.test("unknownModelType returns correct error", () => {
  const error = unknownModelType("bad/type");
  assertEquals(error.code, "unknown_model_type");
  assertEquals(error.message, "Unknown behavior type: bad/type");
  assertEquals(messageFor(error, "model"), "Unknown model type: bad/type");
});

Deno.test("unknownMethod returns correct error", () => {
  const error = unknownMethod("bad", "test/model", "run, create");
  assertEquals(error.code, "unknown_method");
  assertEquals(
    error.message,
    "Unknown method 'bad' for type 'test/model'. Available methods: run, create",
  );
});

Deno.test("noEvaluatedDefinition returns correct error", () => {
  const error = noEvaluatedDefinition("my-model");
  assertEquals(error.code, "no_evaluated_definition");
  assertEquals(
    error.message.includes("my-model"),
    true,
  );
});

Deno.test("methodExecutionFailed wraps error", () => {
  const error = methodExecutionFailed(new Error("boom"));
  assertEquals(error.code, "method_execution_failed");
  assertEquals(error.message, "boom");
  assertEquals(error.cause?.message, "boom");
});

// ---------- Unknown override input key rejection ----------

Deno.test("modelMethodRun: rejects unknown override input key with validation_failed error", async () => {
  const definition = Definition.create({
    name: "test-model",
    methods: { run: { arguments: {} } },
  });
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      ...createTestInput("test-model", "run"),
      // "typoKey" is not a model input key and not a method argument key
      inputs: { typoKey: "oops" },
    }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertEquals(errorEvent.error.code, "validation_failed");
    assertEquals(errorEvent.error.message.includes("typoKey"), true);
  }
});

Deno.test("modelMethodRun: accepts known override input key", async () => {
  const definition = Definition.create({
    name: "test-model",
    methods: { run: { arguments: {} } },
  });
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      ...createTestInput("test-model", "run"),
      // "key" is in the method schema z.object({ key: z.string().optional() })
      inputs: { key: "hello" },
    }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent, undefined);
  const completedEvent = events.find((e) => e.kind === "completed");
  assertEquals(completedEvent?.kind, "completed");
});

Deno.test("modelMethodRun: rejects prototype-chain key like 'constructor'", async () => {
  const definition = Definition.create({
    name: "test-model",
    methods: { run: { arguments: {} } },
  });
  const modelDef = createTestModelDef("run");
  const deps = createTestDeps(definition, modelDef);

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      ...createTestInput("test-model", "run"),
      // "constructor" is on Object.prototype but is NOT a method argument
      inputs: { constructor: "oops" },
    }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertEquals(errorEvent.error.code, "validation_failed");
    assertEquals(errorEvent.error.message.includes("constructor"), true);
  }
});

Deno.test("modelMethodRun: rejects unknown key when method arguments use .refine()", async () => {
  const definition = Definition.create({
    name: "refined-model",
    methods: { run: { arguments: {} } },
  });
  const modelDef: ModelDefinition = {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    methods: {
      run: {
        description: "Test method with refined arguments",
        arguments: z.object({ key: z.string().optional() }).refine(
          (v) => v.key !== "forbidden",
          { message: "key cannot be 'forbidden'" },
        ),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  const deps = createTestDeps(definition, modelDef);

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      ...createTestInput("refined-model", "run"),
      inputs: { typoKey: "oops" },
    }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertEquals(errorEvent.error.code, "validation_failed");
    assertEquals(errorEvent.error.message.includes("typoKey"), true);
  }
});

// --- Sensitive argument registration tests ---

Deno.test("modelMethodRun: registers sensitive string-array method arg values with the redactor", async () => {
  const secretValue = "SUPER_SECRET_TOKEN_XYZ";
  const redactor = new SecretRedactor();

  const modelDef: ModelDefinition = {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    methods: {
      run: {
        description: "Test method with sensitive array arg",
        arguments: z.object({
          command: z.array(z.string()).meta({ sensitive: true }),
          name: z.string().optional(),
        }),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };

  const definition = Definition.create({
    name: "sensitive-arg-model",
    methods: {
      run: {
        arguments: { command: ["sh", "-c", secretValue], name: "test-step" },
      },
    },
  });

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor,
        cleanup: () => {},
      }),
  };

  const ctx = createLibSwampContext();
  await collect(
    modelMethodRun(ctx, deps, createTestInput("sensitive-arg-model", "run")),
  );

  // Long token must be scrubbed; short elements "sh" and "-c" fall below the 3-char threshold
  assertEquals(redactor.redact(secretValue), "***");
  assertEquals(redactor.redact("not-a-secret"), "not-a-secret");
});

Deno.test("modelMethodRun: registers sensitive string method arg values with the redactor", async () => {
  const secretValue = "s3cr3t-api-key-abc123";
  const redactor = new SecretRedactor();

  const modelDef: ModelDefinition = {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    methods: {
      run: {
        description: "Test method with sensitive string arg",
        arguments: z.object({
          apiKey: z.string().meta({ sensitive: true }),
          region: z.string().optional(),
        }),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };

  const definition = Definition.create({
    name: "sensitive-string-model",
    methods: {
      run: {
        arguments: { apiKey: secretValue, region: "us-east-1" },
      },
    },
  });

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor,
        cleanup: () => {},
      }),
  };

  const ctx = createLibSwampContext();
  await collect(
    modelMethodRun(ctx, deps, createTestInput("sensitive-string-model", "run")),
  );

  assertEquals(redactor.redact(secretValue), "***");
  // Non-sensitive field value is not redacted
  assertEquals(redactor.redact("us-east-1"), "us-east-1");
});

Deno.test("modelMethodRun: the completed run masks literal sensitive argument values (swamp-club#3555)", async () => {
  const vaultRef = "${{ vault.get('rv', 'K') }}";
  const modelDef: ModelDefinition = {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    globalArguments: z.object({
      gtoken: z.string().meta({ sensitive: true }).optional(),
      vtoken: z.string().meta({ sensitive: true }).optional(),
      region: z.string().optional(),
    }),
    methods: {
      run: {
        description: "Takes a sensitive argument",
        arguments: z.object({
          secret: z.string().meta({ sensitive: true }),
          name: z.string().optional(),
        }),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  const definition = Definition.create({
    name: "sensitive-display-model",
    globalArguments: {
      gtoken: "${{ inputs.tok }}",
      vtoken: vaultRef,
      region: "us-east-1",
    },
    methods: { run: { arguments: {} } },
  });
  const evaluationService = createFakeEvaluationService();
  evaluationService.hasDefinitionExpressions = () => true;
  // The expression pass resolves the inputs reference to plaintext and
  // leaves the vault reference for the runtime pass.
  evaluationService.evaluateDefinition = (def: Definition) => {
    const evaluated = Definition.fromData(def.toData());
    evaluated.setGlobalArgument("gtoken", "GLOBAL-CANARY");
    return Promise.resolve({
      definition: evaluated,
      type: TEST_MODEL_TYPE,
      hadExpressions: true,
    });
  };
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createEvaluationService: () => evaluationService,
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: new SecretRedactor(),
        cleanup: () => {},
      }),
  };

  const events = await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("sensitive-display-model", "run"),
      inputs: { secret: "METHOD-CANARY", name: "visible" },
    }),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.methodArguments, {
      secret: "***",
      name: "visible",
    });
    assertEquals(completed.run.globalArguments, {
      gtoken: "***",
      vtoken: vaultRef,
      region: "us-east-1",
    });
  }
});

Deno.test("modelMethodRun: refuses a stored definition holding a literal sensitive global argument (swamp-club#3555)", async () => {
  let executed = false;
  const modelDef: ModelDefinition = {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    globalArguments: z.object({
      gtoken: z.string().meta({ sensitive: true }).optional(),
    }),
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args, _ctx) => {
          executed = true;
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
  const definition = Definition.create({
    name: "literal-global-model",
    globalArguments: { gtoken: "GLOBAL-CANARY" },
    methods: { run: { arguments: {} } },
  });

  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      createTestDeps(definition, modelDef),
      createTestInput("literal-global-model", "run"),
    ),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
  if (error?.kind === "error") {
    assertEquals(error.error.code, "validation_failed");
    assertStringIncludes(error.error.message, "'gtoken'");
    assertEquals(error.error.message.includes("GLOBAL-CANARY"), false);
  }
  assertEquals(events.some((e) => e.kind === "executing"), false);
  assertEquals(executed, false);
});

Deno.test("modelMethodRun: refuses a literal an upgrade moves into a sensitive global argument (swamp-club#3555)", async () => {
  let executed = false;
  const modelDef: ModelDefinition = {
    type: TEST_MODEL_TYPE,
    version: "2026.02.01.1",
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }).optional(),
    }),
    upgrades: [{
      toVersion: "2026.02.01.1",
      description: "Rename token to apiKey",
      upgradeAttributes: (old: Record<string, unknown>) => {
        const { token, ...rest } = old;
        return { ...rest, apiKey: token };
      },
    }],
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args, _ctx) => {
          executed = true;
          return Promise.resolve({ dataHandles: [] });
        },
      },
    },
  };
  const definition = Definition.create({
    name: "stale-token-model",
    typeVersion: "2026.01.01.1",
    globalArguments: { token: "GLOBAL-CANARY" },
    methods: { run: { arguments: {} } },
  });

  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      createTestDeps(definition, modelDef),
      createTestInput("stale-token-model", "run"),
    ),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
  if (error?.kind === "error") {
    assertEquals(error.error.code, "validation_failed");
    assertStringIncludes(error.error.message, "'apiKey'");
    assertEquals(error.error.message.includes("GLOBAL-CANARY"), false);
  }
  assertEquals(events.some((e) => e.kind === "completed"), false);
  assertEquals(executed, false);
});

Deno.test("modelMethodRun: direct execution resolves @-prefixed type from registry", async () => {
  const nsType = ModelType.create("@myorg/custom-model");
  const modelDef: ModelDefinition = {
    type: nsType,
    version: "2026.01.01.1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(null, undefined),
    getModelDef: (type) => {
      const key = typeof type === "string"
        ? ModelType.create(type).normalized
        : type.normalized;
      if (key === nsType.normalized) return modelDef;
      return undefined;
    },
    createAndSaveDefinition: async (_type, _def) => {},
    getDefinitionPath: (_type, id) => `/tmp/auto/${id}.yaml`,
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      modelIdOrName: "my-instance",
      methodName: "run",
      inputs: {},
      lastEvaluated: false,
      typeArg: "@myorg/custom-model",
      definitionName: "my-instance",
    }),
  );

  const autoCreated = events.find((e) => e.kind === "auto_created");
  assertEquals(autoCreated !== undefined, true);
  if (autoCreated && autoCreated.kind === "auto_created") {
    assertEquals(autoCreated.modelType, "@myorg/custom-model");
  }
});

Deno.test("modelMethodRun: direct execution uses canonical type when getModelDef resolves @-prefixed internal type", async () => {
  // Simulates the #1676 fix: getModelDef("@swamp/grant") returns the model def
  // (because resolveModelType strips @ for internal types), but the model's
  // canonical type is "swamp/grant" (without @). Data must be stored under
  // the canonical type to be discoverable by findAllForType.
  const canonicalType = ModelType.create("swamp/grant");
  const modelDef: ModelDefinition = {
    type: canonicalType,
    version: "2026.06.17.1",
    methods: {
      create: {
        description: "Create a grant",
        arguments: z.object({}),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(null, undefined),
    getModelDef: (type) => {
      const key = typeof type === "string"
        ? ModelType.create(type).normalized
        : type.normalized;
      // Matches both "@swamp/grant" and "swamp/grant" — just like
      // resolveModelType after the #1676 fix
      if (key === "@swamp/grant" || key === "swamp/grant") return modelDef;
      return undefined;
    },
    createAndSaveDefinition: async (_type, _def) => {},
    getDefinitionPath: (_type, id) => `/tmp/auto/${id}.yaml`,
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      modelIdOrName: "@swamp/grant",
      methodName: "create",
      inputs: {},
      lastEvaluated: false,
      typeArg: "@swamp/grant",
      definitionName: "grant-abc123",
    }),
  );

  const autoCreated = events.find((e) => e.kind === "auto_created");
  assertEquals(autoCreated !== undefined, true);
  if (autoCreated && autoCreated.kind === "auto_created") {
    assertEquals(autoCreated.modelType, "swamp/grant");
  }
});

Deno.test("modelMethodRun: direct execution strips @ fallback for repo-local types", async () => {
  const localType = ModelType.create("sandbox/coder-server");
  const modelDef: ModelDefinition = {
    type: localType,
    version: "2026.01.01.1",
    methods: {
      status: {
        description: "Check status",
        arguments: z.object({}),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(null, undefined),
    getModelDef: (type) => {
      const key = typeof type === "string"
        ? ModelType.create(type).normalized
        : type.normalized;
      if (key === localType.normalized) return modelDef;
      return undefined;
    },
    createAndSaveDefinition: async (_type, _def) => {},
    getDefinitionPath: (_type, id) => `/tmp/auto/${id}.yaml`,
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    modelMethodRun(ctx, deps, {
      modelIdOrName: "my-server",
      methodName: "status",
      inputs: {},
      lastEvaluated: false,
      typeArg: "@sandbox/coder-server",
      definitionName: "my-server",
    }),
  );

  const autoCreated = events.find((e) => e.kind === "auto_created");
  assertEquals(autoCreated !== undefined, true);
  if (autoCreated && autoCreated.kind === "auto_created") {
    assertEquals(autoCreated.modelType, "sandbox/coder-server");
  }
});

Deno.test("modelMethodRun: yields auto_gc_completed when autoGc is true and versions are removed", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = {
    ...createTestDeps(definition, modelDef),
    dataRepo: createFakeDataRepo({ versionsRemoved: 8, bytesReclaimed: 2048 }),
  };

  const events = await collect<ModelMethodRunEvent>(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("test-model", "run"),
      autoGc: true,
    }),
  );

  const gcEvent = events.find((e) => e.kind === "auto_gc_completed");
  assertEquals(gcEvent !== undefined, true);
  if (gcEvent && gcEvent.kind === "auto_gc_completed") {
    assertEquals(gcEvent.versionsDeleted, 8);
    assertEquals(gcEvent.bytesReclaimed, 2048);
  }
});

Deno.test("modelMethodRun: does not yield auto_gc_completed when autoGc is false", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const deps = {
    ...createTestDeps(definition, modelDef),
    dataRepo: createFakeDataRepo({ versionsRemoved: 8, bytesReclaimed: 2048 }),
  };

  const events = await collect<ModelMethodRunEvent>(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("test-model", "run"),
      autoGc: false,
    }),
  );

  const gcEvent = events.find((e) => e.kind === "auto_gc_completed");
  assertEquals(gcEvent, undefined);
});

// --- EventBus ModelUpdated emission tests ---

Deno.test("modelMethodRun: publishes ModelUpdated when method writes data and eventBus is provided", async () => {
  const definition = createTestDefinition("test-model", "run");
  const dataHandle = {
    dataId: generateDataId(),
    name: "grant-main",
    specName: "grant",
    kind: "resource" as const,
    version: 1,
    size: 42,
    tags: {},
    metadata: { contentType: "application/json" },
  } as DataHandle;
  const modelDef = createTestModelDef("run");

  const eventBus = new EventBus();
  const published: ModelUpdated[] = [];
  eventBus.subscribe<ModelUpdated>("ModelUpdated", (event) => {
    published.push(event);
  });

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      ({
        executeWorkflow: () => Promise.resolve({ dataHandles: [dataHandle] }),
        // deno-lint-ignore no-explicit-any
      }) as any,
    eventBus,
  };

  const ctx = createLibSwampContext();
  await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  assertEquals(published.length, 1);
  assertEquals(published[0].modelType, "test/model");
  assertEquals(published[0].modelName, "test-model");
  assertEquals(published[0].dataVersions, [{ name: "grant-main", version: 1 }]);
});

Deno.test("modelMethodRun: does not publish ModelUpdated when method writes no data", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");

  const eventBus = new EventBus();
  const published: ModelUpdated[] = [];
  eventBus.subscribe<ModelUpdated>("ModelUpdated", (event) => {
    published.push(event);
  });

  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    eventBus,
  };

  const ctx = createLibSwampContext();
  await collect(
    modelMethodRun(ctx, deps, createTestInput("test-model", "run")),
  );

  assertEquals(published.length, 0);
});

const FAILED_RAW = "${{ data.latest('producer', 'log').nope }}";

function createFailingEvaluationDeps(
  definition: Definition,
  executed: string[],
): ModelMethodRunDeps {
  return {
    ...createTestDeps(definition, createTestModelDef("run")),
    createEvaluationService: () => ({
      ...createFakeEvaluationService(),
      hasDefinitionExpressions: () => true,
      evaluateDefinition: (def: Definition) =>
        Promise.resolve({
          definition: def,
          type: TEST_MODEL_TYPE,
          hadExpressions: true,
          authoredExpressions: new Set([FAILED_RAW]),
          failedExpressions: new Map([
            [FAILED_RAW, new Error("Invalid expression: No such key: nope")],
          ]),
        }),
    }),
    createExecutionService: () =>
      ({
        executeWorkflow: async (
          _def: Definition,
          _modelDef: unknown,
          name: string,
          _context: unknown,
          options?: { onArgumentsValidated?: () => Promise<void> },
        ) => {
          await validatedArguments(options);
          executed.push(name);
          return { dataHandles: [] };
        },
        // deno-lint-ignore no-explicit-any
      }) as any,
  };
}

Deno.test("modelMethodRun: fails with the CEL error when the method's own argument failed to evaluate (swamp-club#2397)", async () => {
  const definition = Definition.create({
    name: "consumer",
    methods: { run: { arguments: { key: `cat ${FAILED_RAW}` } } },
  });
  const executed: string[] = [];
  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      createFailingEvaluationDeps(definition, executed),
      createTestInput("consumer", "run"),
    ),
  );

  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "validation_failed");
    assertStringIncludes(
      last.error.message,
      "Expression in methods.run.arguments.key could not be evaluated",
    );
    assertStringIncludes(last.error.message, "No such key: nope");
    assertEquals(last.error.details, {
      path: "methods.run.arguments.key",
      expression: FAILED_RAW,
    });
  }
  assertEquals(executed, []);
});

Deno.test("modelMethodRun: a run that fails the argument check does not replace the saved evaluation", async () => {
  const definition = Definition.create({
    name: "consumer",
    methods: { run: { arguments: { key: `cat ${FAILED_RAW}` } } },
  });
  const saved: Definition[] = [];
  const deps: ModelMethodRunDeps = {
    ...createFailingEvaluationDeps(definition, []),
    saveEvaluatedDefinition: (_type, def) => {
      saved.push(def);
      return Promise.resolve();
    },
  };
  await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("consumer", "run"),
    ),
  );
  assertEquals(saved, []);

  // A passing run still saves, without the --input overrides.
  await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      { ...createTestInput("consumer", "run"), inputs: { key: "overridden" } },
    ),
  );
  assertEquals(saved.length, 1);
  assertEquals(saved[0].getMethodArguments("run"), {
    key: `cat ${FAILED_RAW}`,
  });
});

Deno.test("modelMethodRun: a failed expression in another method's arguments does not stop this method", async () => {
  const definition = Definition.create({
    name: "two-methods",
    methods: {
      run: { arguments: { key: "value" } },
      update: { arguments: { key: FAILED_RAW } },
    },
  });
  const executed: string[] = [];
  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      createFailingEvaluationDeps(definition, executed),
      createTestInput("two-methods", "run"),
    ),
  );

  assertEquals(events.some((e) => e.kind === "error"), false);
  assertEquals(executed, ["run"]);
});

Deno.test("modelMethodRun: the runtime pass is scoped to the invoked method", async () => {
  const definition = createTestDefinition("scoped-model", "run");
  let seenMethod: string | undefined;
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, createTestModelDef("run")),
    createEvaluationService: () => ({
      ...createFakeEvaluationService(),
      resolveRuntimeExpressionsInDefinition: (
        def: Definition,
        _redactor: unknown,
        _ctx: unknown,
        _authored: unknown,
        options?: { methodName?: string },
      ) => {
        seenMethod = options?.methodName;
        return Promise.resolve({
          definition: def,
          secretBag: new VaultSecretBag(new SecretBagRegistry()),
        });
      },
    }),
  };

  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("scoped-model", "run"),
    ),
  );

  assertEquals(events.some((e) => e.kind === "error"), false);
  assertEquals(seenMethod, "run");
});

Deno.test("modelMethodRun: an --input override replacing the failed argument lets the method run", async () => {
  const definition = Definition.create({
    name: "consumer",
    methods: { run: { arguments: { key: `cat ${FAILED_RAW}` } } },
  });
  const executed: string[] = [];
  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      createFailingEvaluationDeps(definition, executed),
      { ...createTestInput("consumer", "run"), inputs: { key: "overridden" } },
    ),
  );

  assertEquals(events.some((e) => e.kind === "error"), false);
  assertEquals(executed, ["run"]);
});

Deno.test("modelMethodRun: schema-declared inputs contribute authored expressions to the runtime pass", async () => {
  const definition = Definition.create({
    name: "schema-input-model",
    inputs: {
      type: "object",
      properties: { value: { type: "string" } },
    },
    methods: {
      run: { arguments: { key: "${{ inputs.value }}" } },
    },
  });

  let seenAuthored: ReadonlySet<string> | "unrestricted" | undefined;
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, createTestModelDef("run")),
    createEvaluationService: () => ({
      ...createFakeEvaluationService(),
      resolveRuntimeExpressionsInDefinition: (
        def: Definition,
        _redactor: unknown,
        _ctx: unknown,
        authored: ReadonlySet<string> | "unrestricted",
      ) => {
        seenAuthored = authored;
        return Promise.resolve({
          definition: def,
          secretBag: new VaultSecretBag(new SecretBagRegistry()),
        });
      },
    }),
  };

  await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("schema-input-model", "run"),
      inputs: { value: "${{ env.HOME }}" },
    }),
  );

  assertEquals(
    seenAuthored !== "unrestricted" && seenAuthored?.has("${{ env.HOME }}"),
    true,
  );
});

Deno.test("modelMethodRun: byId resolves through lookupDefinitionById, never the name-first lookup", async () => {
  const byIdDefinition = createTestDefinition("by-id-model", "run");
  const id = byIdDefinition.id;
  const calls: string[] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(
      createTestDefinition("name-first-decoy", "run"),
      createTestModelDef("run"),
    ),
    lookupDefinition: (idOrName) => {
      calls.push(`name:${idOrName}`);
      return Promise.reject(new Error("name-first lookup must not be used"));
    },
    lookupDefinitionById: (lookupId) => {
      calls.push(`id:${lookupId}`);
      return Promise.resolve({
        definition: byIdDefinition,
        type: TEST_MODEL_TYPE,
      });
    },
  };

  const events = await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput(id, "run"),
      byId: true,
    }),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.run.modelName, "by-id-model");
    assertEquals(completed.run.status, "succeeded");
  }
  assertEquals(calls, [`id:${id}`]);
});

Deno.test("modelMethodRun: byId without lookupDefinitionById fails instead of falling back to name lookup", async () => {
  let nameLookups = 0;
  const base = createTestDeps(
    createTestDefinition("test-model", "run"),
    createTestModelDef("run"),
  );
  const deps: ModelMethodRunDeps = {
    ...base,
    lookupDefinition: (idOrName) => {
      nameLookups++;
      return base.lookupDefinition(idOrName);
    },
  };

  await assertRejects(
    () =>
      collect(
        modelMethodRun(createLibSwampContext(), deps, {
          ...createTestInput(crypto.randomUUID(), "run"),
          byId: true,
        }),
      ),
    Error,
    "none is wired",
  );
  assertEquals(nameLookups, 0);
});

Deno.test("modelMethodRun: --last-evaluated refuses a cache written before sensitive values were kept off disk (swamp-club#2171)", async () => {
  const definition = createTestDefinition("test-model", "run");
  const deps = {
    ...createTestDeps(definition, createTestModelDef("run")),
    loadEvaluatedDefinition: () =>
      Promise.resolve({
        definition,
        authoredExpressions: new Set(["${{ data.latest('db', 'creds') }}"]),
      }),
  };
  const events = await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("test-model", "run"),
      lastEvaluated: true,
    }),
  );
  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "evaluated_cache_may_hold_secrets");
    assertStringIncludes(last.error.message, "without --last-evaluated");
  }
});

Deno.test("modelMethodRun: --last-evaluated refuses a cache written in a newer sensitive-value format before anything runs, since its values may be in a form this swamp does not recognise (swamp-club#3681)", async () => {
  const definition = createTestDefinition("test-model", "run");
  const deps = {
    ...createTestDeps(definition, createTestModelDef("run")),
    loadEvaluatedDefinition: () =>
      Promise.resolve({
        definition,
        authoredExpressions: new Set<string>(),
        sensitiveFormat: SENSITIVE_FORMAT_VERSION + 1,
      }),
  };
  const events = await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("test-model", "run"),
      lastEvaluated: true,
    }),
  );
  const last = events[events.length - 1];
  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "evaluated_cache_format_newer");
    assertStringIncludes(last.error.message, "newer swamp");
    assertStringIncludes(last.error.message, "without --last-evaluated");
  }
  assertEquals(
    events.some((event) =>
      event.kind === "completed" || event.kind === "executing"
    ),
    false,
  );
});

Deno.test("modelMethodRun: --last-evaluated restores cached references into the executed copy as sentinels (swamp-club#2171)", async () => {
  const secret = "Pl41n-s3cret";
  const cached = Definition.create({
    name: "test-model",
    methods: {
      run: {
        arguments: { key: "echo ${{ vault.get('prod', 'api-token') }}" },
      },
    },
  });
  let executed: Definition | undefined;
  let executedBag: VaultSecretBag | undefined;
  let reported: Record<string, unknown> | undefined;
  const evaluationService = createFakeEvaluationService();
  evaluationService.resolveRuntimeExpressionsInDefinition = (
    def: Definition,
    _redactor: unknown,
    _context: unknown,
    _authored: unknown,
    options: { secretBag: VaultSecretBag },
  ) => {
    executed = def;
    executedBag = options.secretBag;
    return Promise.resolve({ definition: def, secretBag: options.secretBag });
  };
  const deps = {
    ...createTestDeps(
      createTestDefinition("test-model", "run"),
      createTestModelDef("run"),
    ),
    createEvaluationService: () => evaluationService,
    createVaultService: () =>
      Promise.resolve(
        { get: () => Promise.resolve(secret) } as unknown as Awaited<
          ReturnType<ModelMethodRunDeps["createVaultService"]>
        >,
      ),
    loadEvaluatedDefinition: () =>
      Promise.resolve({
        definition: cached,
        authoredExpressions: new Set<string>(),
        sensitiveFormat: SENSITIVE_FORMAT_VERSION,
        writtenReferences: [{
          path: ["methods", "run", "arguments", "key"],
          occurrence: 0,
          vaultName: "prod",
          key: "api-token",
          encoding: "raw" as const,
          dataOrigin: true,
        }],
      }),
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: new SecretRedactor(),
        cleanup: () => {},
      }),
  };
  const events = await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      ...createTestInput("test-model", "run"),
      lastEvaluated: true,
    }),
  );
  for (const event of events) {
    if (event.kind === "completed") reported = event.run.methodArguments;
  }
  const key = executed?.getMethodArguments("run").key as string;
  assertEquals(key.includes(secret), false);
  assertEquals(executedBag?.resolveRaw(key), `echo ${secret}`);
  assertEquals(reported?.key, "echo ***");
});

Deno.test("modelMethodRun keeps an empty-markdown report in the completed run's reports", async () => {
  const reportName = `@test/${crypto.randomUUID()}`;
  reportRegistry.register(reportName, {
    description: "Report with nothing to say",
    scope: "method",
    execute: () => Promise.resolve({ markdown: "", json: {} }),
  });
  try {
    const definition = createTestDefinition("test-model", "run");
    const modelDef = { ...createTestModelDef("run"), reports: [reportName] };
    const events = await collect(
      modelMethodRun(
        createLibSwampContext(),
        createTestDeps(definition, modelDef),
        createTestInput("test-model", "run"),
      ),
    );

    // Matches workflow run, whose JSON also keeps empty reports.
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected a completed event");
    }
    const report = completed.run.reports?.[reportName];
    assertEquals(report?.success, true);
    assertEquals(report?.markdown, "");
  } finally {
    reportRegistry.invalidateType(reportName);
  }
});

Deno.test("modelMethodRun: direct execution refuses a definition other than the one the caller authorized", async () => {
  const nsType = ModelType.create("@myorg/guarded-model");
  const modelDef: ModelDefinition = {
    type: nsType,
    version: "2026.01.01.1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  // The name now resolves to a different definition than the one the caller
  // checked, as after a rename between the check and the run.
  const swapped = Definition.create({ name: "my-instance" });
  let executed = false;
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(null, undefined),
    lookupDefinition: () =>
      Promise.resolve({ definition: swapped, type: nsType }),
    getModelDef: (type) => {
      const key = typeof type === "string"
        ? ModelType.create(type).normalized
        : type.normalized;
      return key === nsType.normalized ? modelDef : undefined;
    },
    createAndSaveDefinition: (_type, _def) => {
      executed = true;
      return Promise.resolve();
    },
    getDefinitionPath: (_type, id) => `/tmp/auto/${id}.yaml`,
  };

  for (const expectedDefinitionId of ["authorized-id", null]) {
    const failure = await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: "my-instance",
        methodName: "run",
        inputs: {},
        lastEvaluated: false,
        typeArg: "@myorg/guarded-model",
        definitionName: "my-instance",
        expectedDefinitionId,
      }),
    ).then(
      (events) => JSON.stringify(events.find((e) => e.kind === "error")),
      (error) => String(error),
    );
    assertStringIncludes(failure, "changed while the request was being");
  }
  assertEquals(executed, false);
});

Deno.test("modelMethodRun: direct execution proceeds on a different definition the caller authorizes", async () => {
  const nsType = ModelType.create("@myorg/raced-model");
  const modelDef: ModelDefinition = {
    type: nsType,
    version: "2026.01.01.1",
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
  // A concurrent run created the definition after this one was authorized.
  const winner = Definition.create({ name: "my-instance" });
  const seen: string[] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(null, undefined),
    lookupDefinition: (name: string) =>
      Promise.resolve(
        name === "my-instance" ? { definition: winner, type: nsType } : null,
      ),
    getModelDef: (type) => {
      const key = typeof type === "string"
        ? ModelType.create(type).normalized
        : type.normalized;
      return key === nsType.normalized ? modelDef : undefined;
    },
    createAndSaveDefinition: () => Promise.resolve(),
    getDefinitionPath: (_type, id) => `/tmp/auto/${id}.yaml`,
  };
  const run = (allow: boolean) =>
    collect(
      modelMethodRun(createLibSwampContext(), deps, {
        modelIdOrName: "my-instance",
        methodName: "run",
        inputs: {},
        lastEvaluated: false,
        typeArg: "@myorg/raced-model",
        definitionName: "my-instance",
        expectedDefinitionId: null,
        authorizeResolvedDefinition: (found) => {
          seen.push(found.definition.id);
          return allow;
        },
      }),
    ).then(
      (events) => JSON.stringify(events.find((e) => e.kind === "error") ?? ""),
      (error) => String(error),
    );
  assertEquals((await run(true)).includes("changed while"), false);
  // A definition renamed in since a check that found one is never adopted,
  // even when the caller may run it: its lock was not taken.
  const renamedIn = await collect(
    modelMethodRun(createLibSwampContext(), deps, {
      modelIdOrName: "my-instance",
      methodName: "run",
      inputs: {},
      lastEvaluated: false,
      typeArg: "@myorg/raced-model",
      definitionName: "my-instance",
      expectedDefinitionId: "authorized-id",
      authorizeResolvedDefinition: () => true,
    }),
  ).then(
    (events) => JSON.stringify(events.find((e) => e.kind === "error") ?? ""),
    (error) => String(error),
  );
  assertStringIncludes(renamedIn, "changed while the request was being");
  assertStringIncludes(await run(false), "changed while the request was being");
  assertEquals(seen.every((id) => id === winner.id), true);
});

Deno.test("modelMethodRun: tells onWrittenVersions what a completed run wrote (swamp-club#3146)", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const dataHandle = {
    dataId: generateDataId(),
    name: "state",
    specName: "state",
    kind: "resource" as const,
    version: 7,
    size: 2,
    tags: {},
    metadata: { contentType: "text/plain" },
  } as DataHandle;
  const told: [readonly WrittenVersion[], string][] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () =>
      ({
        executeWorkflow: () => Promise.resolve({ dataHandles: [dataHandle] }),
        // deno-lint-ignore no-explicit-any
      }) as any,
    onWrittenVersions: (versions, outcome) => told.push([versions, outcome]),
  };

  await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("test-model", "run"),
    ),
  );

  assertEquals(told, [[[{
    modelType: "test/model",
    modelId: definition.id,
    dataName: "state",
    version: 7,
  }], "completed"]]);
});

Deno.test("modelMethodRun: tells onWrittenVersions what a failed run wrote, a worker's included (swamp-club#3146)", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const fromWorker: WrittenVersion = {
    modelType: "test/model",
    modelId: definition.id,
    dataName: "remote-state",
    version: 3,
  };
  const error = new Error("execution boom") as Error & {
    dataHandles?: DataHandle[];
    writtenVersions?: WrittenVersion[];
  };
  error.dataHandles = [{
    dataId: generateDataId(),
    name: "partial-state",
    specName: "state",
    kind: "resource" as const,
    version: 1,
    size: 42,
    tags: {},
    metadata: { contentType: "application/json" },
  } as DataHandle];
  error.writtenVersions = [fromWorker];
  const told: [readonly WrittenVersion[], string][] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    createExecutionService: () => createFailingExecutionService(error),
    outputRepo: createFakeOutputRepo(),
    onWrittenVersions: (versions, outcome) => told.push([versions, outcome]),
  };

  const events = await collect<ModelMethodRunEvent>(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("test-model", "run"),
    ),
  );

  assertEquals(events[events.length - 1].kind, "error");
  assertEquals(told, [[[
    {
      modelType: "test/model",
      modelId: definition.id,
      dataName: "partial-state",
      version: 1,
    },
    fromWorker,
  ], "failed"]]);
});

Deno.test("methodExecutionFailed: keeps a worded cause's model spelling (swamp-club#3437)", () => {
  const cause = wordedUserError(
    wordedText((w) => `${w.Noun} "x" stores sensitive output`),
  );
  const error = methodExecutionFailed(cause);
  assertEquals(error.message, 'Behavior "x" stores sensitive output');
  assertEquals(messageFor(error, "model"), 'Model "x" stores sensitive output');
});

/** A type with sensitive global and method arguments (swamp-club#3681). */
function createSensitiveModelDef(): ModelDefinition {
  return {
    type: TEST_MODEL_TYPE,
    version: "1.0.0",
    globalArguments: z.object({
      gtoken: z.string().meta({ sensitive: true }).optional(),
      vtoken: z.string().meta({ sensitive: true }).optional(),
      region: z.string().optional(),
    }),
    methods: {
      run: {
        description: "Takes a sensitive argument",
        arguments: z.object({
          secret: z.string().meta({ sensitive: true }).optional(),
          name: z.string().optional(),
        }),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
      deploy: {
        description: "Another method with a sensitive argument",
        arguments: z.object({
          password: z.string().meta({ sensitive: true }).optional(),
        }),
        execute: (_args, _ctx) => Promise.resolve({ dataHandles: [] }),
      },
    },
  };
}

Deno.test("methodExecutionFailed: passes the message, the stack and the model spelling through the redactor, keeping the cause's marked paths; without one the cause is kept as it is (swamp-club#3681)", () => {
  const redactor = new SecretRedactor();
  redactor.addSecret("hunter22");
  const cause = markErrorPaths(
    wordedUserError(wordedText((w) => `${w.Noun} "x" leaked hunter22`)),
    ["a.b"],
  );
  const error = methodExecutionFailed(cause, redactor);
  assertEquals(error.message, 'Behavior "x" leaked ***');
  assertEquals(messageFor(error, "model"), 'Model "x" leaked ***');
  assertEquals(error.cause?.stack?.includes("hunter22"), false);
  assertEquals(error.cause?.stack?.includes("***"), true);
  assertEquals(errorPaths(error.cause), ["a.b"]);
  assertEquals(methodExecutionFailed(cause).cause, cause);
  assertEquals(methodExecutionFailed(cause, new SecretRedactor()).cause, cause);
});

Deno.test("modelMethodRun: a method error that echoes a sensitive argument reaches the error event and the output record masked (swamp-club#3681)", async () => {
  const definition = Definition.create({
    name: "echo",
    methods: { run: { arguments: { secret: "TOP-SECRET-VALUE", name: "n" } } },
  });
  const saved: ModelOutput[] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, createSensitiveModelDef()),
    outputRepo: {
      ...createFakeOutputRepo(),
      save: (_type: unknown, _method: unknown, output: ModelOutput) => {
        saved.push(output);
        return Promise.resolve();
      },
    },
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: new SecretRedactor(),
        cleanup: () => {},
      }),
    createExecutionService: () =>
      ({
        executeWorkflow: () =>
          Promise.reject(new Error("failed with TOP-SECRET-VALUE")),
        // deno-lint-ignore no-explicit-any
      }) as any,
  };
  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("echo", "run"),
    ),
  );
  const last = events.at(-1);
  assertEquals(last?.kind, "error");
  if (last?.kind === "error") {
    assertEquals(last.error.code, "method_execution_failed");
    assertEquals(last.error.message, "failed with ***");
    assertEquals(last.error.cause?.stack?.includes("TOP-SECRET-VALUE"), false);
  }
  assertEquals(saved.at(-1)?.error?.message, "failed with ***");
  assertEquals(
    saved.at(-1)?.error?.stack?.includes("TOP-SECRET-VALUE"),
    false,
  );
});

Deno.test("modelMethodRun: the run's sensitive values come from createSensitiveValues, and their registry reaches the passes and the delivery", async () => {
  const definition = createTestDefinition("test-model", "run");
  const modelDef = createTestModelDef("run");
  const seen: SecretBagRegistry[] = [];
  let delivered: SecretBagRegistry | undefined;
  const typedRegistry = new SecretBagRegistry({ typedSecrets: true });
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, modelDef),
    // A typed run's values mask the registry's sentinels through the redactor.
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: new SecretRedactor(),
        cleanup: () => {},
      }),
    createSensitiveValues: (redactor) =>
      new RunSensitiveValues(redactor, typedRegistry),
    createEvaluationService: () => ({
      ...createFakeEvaluationService(),
      hasDefinitionExpressions: () => true,
      evaluateDefinition: (
        def: Definition,
        _type: unknown,
        sensitiveValues: RunSensitiveValues,
        _inputs: unknown,
        _ctx: unknown,
        bag: VaultSecretBag,
      ) => {
        seen.push(sensitiveValues.sentinels, bag.registry);
        return Promise.resolve({
          definition: def,
          type: TEST_MODEL_TYPE,
          hadExpressions: false,
        });
      },
      resolveRuntimeExpressionsInDefinition: (
        def: Definition,
        _redactor: unknown,
        _ctx: unknown,
        _authored: unknown,
        options: { secretBag: VaultSecretBag },
      ) => {
        seen.push(options.secretBag.registry);
        return Promise.resolve({
          definition: def,
          secretBag: options.secretBag,
        });
      },
    }),
    createExecutionService: () =>
      ({
        executeWorkflow: (
          _def: Definition,
          _modelDef: unknown,
          _method: string,
          ctx: { vaultSecrets?: VaultSecretBag },
        ) => {
          delivered = ctx.vaultSecrets?.registry;
          return Promise.resolve({ dataHandles: [] });
        },
        // deno-lint-ignore no-explicit-any
      }) as any,
  };
  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("test-model", "run"),
    ),
  );
  assertEquals(events.some((e) => e.kind === "error"), false);
  assertEquals(seen.length, 3);
  for (const registry of seen) assertEquals(registry, typedRegistry);
  assertEquals(delivered, typedRegistry);
  assertEquals(typedRegistry.typedSecrets, true);
});

Deno.test("modelMethodRun: the saved evaluated definition holds the mask for a sensitive argument fed from an input, beside a vault reference (swamp-club#3681)", async () => {
  const vaultRef = "${{ vault.get('rv', 'K') }}";
  const definition = Definition.create({
    name: "input-svc",
    globalArguments: {
      gtoken: "${{ inputs.tok }}",
      vtoken: vaultRef,
      region: "us-east-1",
    },
    methods: {
      run: { arguments: { secret: "${{ inputs.tok }}", name: "visible" } },
    },
  });
  const evaluationService = createFakeEvaluationService();
  evaluationService.hasDefinitionExpressions = () => true;
  // The expression pass resolves the inputs references to plaintext and
  // leaves the vault reference for the runtime pass.
  evaluationService.evaluateDefinition = (def: Definition) => {
    const data = def.toData();
    const evaluated = Definition.fromData({
      ...data,
      globalArguments: { ...data.globalArguments, gtoken: "GLOBAL-CANARY" },
      methods: {
        run: { arguments: { secret: "METHOD-CANARY", name: "visible" } },
      },
    });
    return Promise.resolve({
      definition: evaluated,
      type: TEST_MODEL_TYPE,
      hadExpressions: true,
    });
  };
  const saved: Definition[] = [];
  const recorded: (readonly (string | number)[])[][] = [];
  const deps: ModelMethodRunDeps = {
    ...createTestDeps(definition, createSensitiveModelDef()),
    createEvaluationService: () => evaluationService,
    saveEvaluatedDefinition: (_type, evaluated, _p, _a, _r, maskedPaths) => {
      saved.push(evaluated);
      recorded.push([...(maskedPaths ?? [])]);
      return Promise.resolve();
    },
    createRunLog: () =>
      Promise.resolve({
        logFilePath: "/tmp/test.log",
        redactor: new SecretRedactor(),
        cleanup: () => {},
      }),
  };

  const events = await collect(
    modelMethodRun(
      createLibSwampContext(),
      deps,
      createTestInput("input-svc", "run"),
    ),
  );

  assertEquals(events.at(-1)?.kind, "completed");
  assertEquals(saved.length, 1);
  assertEquals(saved[0].globalArguments, {
    gtoken: "***",
    vtoken: vaultRef,
    region: "us-east-1",
  });
  assertEquals(saved[0].getMethodArguments("run"), {
    secret: "***",
    name: "visible",
  });
  assertEquals(JSON.stringify(saved[0].toData()).includes("CANARY"), false);
  // The masked positions go to the cache beside the definition.
  assertEquals(recorded[0], [
    ["globalArguments", "gtoken"],
    ["methods", "run", "arguments", "secret"],
  ]);
});

Deno.test("modelMethodRun: --last-evaluated refuses a recorded masked argument even when the type no longer marks the field sensitive (swamp-club#3681)", async () => {
  // Version 2 of the type dropped the marker on gtoken.
  const drifted: ModelDefinition = {
    ...createTestModelDef("run"),
    globalArguments: z.object({ gtoken: z.string().optional() }),
  };
  const cached = Definition.create({
    name: "test-model",
    globalArguments: { gtoken: "***" },
    methods: { run: { arguments: {} } },
  });
  const replay = async (maskedPaths: (string | number)[][]) => {
    const deps: ModelMethodRunDeps = {
      ...createTestDeps(createTestDefinition("test-model", "run"), drifted),
      loadEvaluatedDefinition: () =>
        Promise.resolve({
          definition: cached,
          authoredExpressions: new Set<string>(),
          sensitiveFormat: SENSITIVE_FORMAT_VERSION,
          writtenReferences: [],
          maskedPaths,
        }),
      createRunLog: () =>
        Promise.resolve({
          logFilePath: "/tmp/test.log",
          redactor: new SecretRedactor(),
          cleanup: () => {},
        }),
    };
    return await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        ...createTestInput("test-model", "run"),
        lastEvaluated: true,
      }),
    );
  };

  const refused = (await replay([["globalArguments", "gtoken"]])).at(-1);
  assertEquals(refused?.kind, "error");
  if (refused?.kind === "error") {
    assertEquals(
      refused.error.code,
      "evaluated_cache_holds_sensitive_arguments",
    );
    assertStringIncludes(refused.error.message, "'globalArguments.gtoken'");
  }
  // With nothing recorded, the drifted schema alone lets the mask through.
  const events = await replay([]);
  assertEquals(
    events.some((e) =>
      e.kind === "error" &&
      e.error.code === "evaluated_cache_holds_sensitive_arguments"
    ),
    false,
  );
});

Deno.test("modelMethodRun: --last-evaluated refuses a cache whose sensitive argument holds the mask or plaintext, naming the path and never the value; a vault reference replays (swamp-club#3681)", async () => {
  const replay = async (held: string) => {
    const cached = Definition.create({
      name: "test-model",
      globalArguments: { gtoken: held },
      methods: { run: { arguments: {} } },
    });
    const deps: ModelMethodRunDeps = {
      ...createTestDeps(
        createTestDefinition("test-model", "run"),
        createSensitiveModelDef(),
      ),
      loadEvaluatedDefinition: () =>
        Promise.resolve({
          definition: cached,
          authoredExpressions: new Set<string>(),
          sensitiveFormat: SENSITIVE_FORMAT_VERSION,
          writtenReferences: [],
        }),
      createRunLog: () =>
        Promise.resolve({
          logFilePath: "/tmp/test.log",
          redactor: new SecretRedactor(),
          cleanup: () => {},
        }),
    };
    return await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        ...createTestInput("test-model", "run"),
        lastEvaluated: true,
      }),
    );
  };

  for (const held of ["***", "GLOBAL-CANARY"]) {
    const last = (await replay(held)).at(-1);
    assertEquals(last?.kind, "error");
    if (last?.kind === "error") {
      assertEquals(
        last.error.code,
        "evaluated_cache_holds_sensitive_arguments",
      );
      assertStringIncludes(last.error.message, "'globalArguments.gtoken'");
      assertStringIncludes(last.error.message, "without --last-evaluated");
      assertEquals(last.error.message.includes("GLOBAL-CANARY"), false);
    }
  }

  const events = await replay("${{ vault.get('prod', 'api-token') }}");
  assertEquals(
    events.some((e) =>
      e.kind === "error" &&
      e.error.code === "evaluated_cache_holds_sensitive_arguments"
    ),
    false,
  );
});

Deno.test("modelMethodRun: --last-evaluated leaves out a masked method argument an --input override replaces, and refuses it without the override (swamp-club#3681)", async () => {
  // Another method's masked argument never counts: deploy is not what runs.
  const cached = Definition.create({
    name: "test-model",
    globalArguments: { region: "eu" },
    methods: {
      run: { arguments: { secret: "***", name: "x" } },
      deploy: { arguments: { password: "***" } },
    },
  });
  const replay = async (inputs: Record<string, unknown> = {}) => {
    const deps: ModelMethodRunDeps = {
      ...createTestDeps(
        createTestDefinition("test-model", "run"),
        createSensitiveModelDef(),
      ),
      loadEvaluatedDefinition: () =>
        Promise.resolve({
          definition: cached,
          authoredExpressions: new Set<string>(),
          sensitiveFormat: SENSITIVE_FORMAT_VERSION,
          writtenReferences: [],
        }),
      createRunLog: () =>
        Promise.resolve({
          logFilePath: "/tmp/test.log",
          redactor: new SecretRedactor(),
          cleanup: () => {},
        }),
    };
    return await collect(
      modelMethodRun(createLibSwampContext(), deps, {
        ...createTestInput("test-model", "run"),
        lastEvaluated: true,
        inputs,
      }),
    );
  };

  const refused = (await replay()).at(-1);
  assertEquals(refused?.kind, "error");
  if (refused?.kind === "error") {
    assertEquals(
      refused.error.code,
      "evaluated_cache_holds_sensitive_arguments",
    );
    assertStringIncludes(
      refused.error.message,
      "the sensitive argument 'methods.run.arguments.secret'",
    );
    assertEquals(refused.error.message.includes("deploy"), false);
  }

  const events = await replay({ secret: "OVERRIDE-CANARY" });
  assertEquals(
    events.some((e) =>
      e.kind === "error" &&
      e.error.code === "evaluated_cache_holds_sensitive_arguments"
    ),
    false,
  );
});

Deno.test("modelMethodRun: the evaluation is saved through the execution service's onArgumentsValidated, so a run it refuses before then never replaces the cache (swamp-club#3681)", async () => {
  const definition = Definition.create({
    name: "hooked",
    inputs: { type: "object", properties: { v: { type: "string" } } },
    methods: { run: { arguments: { key: "${{ inputs.v }}" } } },
  });
  const evaluationService = createFakeEvaluationService();
  evaluationService.hasDefinitionExpressions = () => true;
  evaluationService.evaluateDefinition = (def: Definition) =>
    Promise.resolve({
      definition: Definition.fromData({
        ...def.toData(),
        methods: { run: { arguments: { key: "resolved" } } },
      }),
      type: TEST_MODEL_TYPE,
      hadExpressions: true,
    });
  const saved: Definition[] = [];
  const order: string[] = [];
  const depsWith = (
    executeWorkflow: (
      options?: { onArgumentsValidated?: () => Promise<void> },
    ) => Promise<unknown>,
  ): ModelMethodRunDeps => ({
    ...createTestDeps(definition, createTestModelDef("run")),
    createEvaluationService: () => evaluationService,
    saveEvaluatedDefinition: (_type, def) => {
      saved.push(def);
      order.push("saved");
      return Promise.resolve();
    },
    createExecutionService: () =>
      ({
        executeWorkflow: (
          _def: unknown,
          _modelDef: unknown,
          _name: unknown,
          _context: unknown,
          options?: { onArgumentsValidated?: () => Promise<void> },
        ) => executeWorkflow(options),
        // deno-lint-ignore no-explicit-any
      }) as any,
  });

  // Refused before validation passes: nothing is saved.
  const refused = await collect(
    modelMethodRun(
      createLibSwampContext(),
      depsWith(() =>
        Promise.reject(new Error("Method arguments validation failed: no"))
      ),
      { ...createTestInput("hooked", "run"), inputs: { v: "x" } },
    ),
  );
  assertEquals(refused.at(-1)?.kind, "error");
  assertEquals(saved, []);

  // Validated: saved once, before the method body runs.
  await collect(
    modelMethodRun(
      createLibSwampContext(),
      depsWith(async (options) => {
        await options?.onArgumentsValidated?.();
        order.push("method");
        return { dataHandles: [] };
      }),
      { ...createTestInput("hooked", "run"), inputs: { v: "x" } },
    ),
  );
  assertEquals(order, ["saved", "method"]);
  assertEquals(saved.length, 1);
  assertEquals(saved[0].getMethodArguments("run"), { key: "resolved" });
});
