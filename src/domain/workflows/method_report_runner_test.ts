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

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger } from "@logtape/logtape";
import {
  type MethodReportArgs,
  MethodReportRunner,
} from "./method_report_runner.ts";
import type { WorkflowExecutionEvent } from "./execution_events.ts";
import { reportRegistry } from "../reports/report_registry.ts";
import type { ReportDefinition } from "../reports/report.ts";
import type {
  MethodReportContext,
  ModelReportContext,
  ReportContext,
} from "../reports/report_context.ts";
import type { ReportFilterOptions } from "../reports/report_execution_service.ts";
import { ModelType } from "../models/model_type.ts";
import type { DataHandle, ModelDefinition } from "../models/model.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { generateDataId } from "../data/mod.ts";
import { Definition } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";

type ReportEvent = Extract<
  WorkflowExecutionEvent,
  { kind: "report_started" | "report_completed" | "report_failed" }
>;

interface SavedArtifact {
  name: string;
  tags: Record<string, string>;
  content: string;
}

interface LogCall {
  template: string;
  props?: Record<string, unknown>;
}

function makeDataRepo(): {
  repo: UnifiedDataRepository;
  saved: SavedArtifact[];
} {
  const saved: SavedArtifact[] = [];
  const repo = {
    nextId: () => generateDataId(),
    findByName: () => Promise.resolve(null),
    listVersions: () => Promise.resolve([]),
    save: (
      _type: ModelType,
      _modelId: string,
      data: { name: string; tags: Record<string, string> },
      content: Uint8Array,
    ) => {
      saved.push({
        name: data.name,
        tags: { ...data.tags },
        content: new TextDecoder().decode(content),
      });
      return Promise.resolve({ version: 1 });
    },
  } as unknown as UnifiedDataRepository;
  return { repo, saved };
}

function makeLogger(warnings: LogCall[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (template: unknown, props?: unknown) => {
      warnings.push({
        template: String(template),
        props: props as Record<string, unknown> | undefined,
      });
    },
    error: () => {},
    fatal: () => {},
  } as unknown as Logger;
}

function makeReport(
  scope: "method" | "model",
  execute?: (context: ReportContext) => Promise<{
    markdown: string;
    json: Record<string, unknown>;
  }>,
): ReportDefinition {
  return {
    description: `Test ${scope} report`,
    scope,
    execute: execute ??
      ((_context: ReportContext) =>
        Promise.resolve({ markdown: `# ${scope}`, json: { scope } })),
  };
}

/** Registers reports in the global registry for the duration of fn. */
async function withReports(
  reports: Array<{ name: string; report: ReportDefinition }>,
  fn: () => Promise<void>,
): Promise<void> {
  for (const { name, report } of reports) {
    reportRegistry.register(name, report);
  }
  try {
    await fn();
  } finally {
    for (const { name } of reports) {
      reportRegistry.invalidateType(name);
    }
  }
}

interface Harness {
  args: MethodReportArgs;
  events: ReportEvent[];
  saved: SavedArtifact[];
  warnings: LogCall[];
}

function makeHarness(
  overrides: Partial<MethodReportArgs> = {},
): Harness {
  const { repo, saved } = makeDataRepo();
  const warnings: LogCall[] = [];
  const events: ReportEvent[] = [];
  const modelType = ModelType.create("test/method-report-runner");
  const definition = Definition.create({
    type: "test/method-report-runner",
    name: `runner-model-${crypto.randomUUID()}`,
  });
  const modelDef: ModelDefinition = {
    type: modelType,
    version: "2025.01.15.1",
    methods: {},
  };

  const args: MethodReportArgs = {
    status: "succeeded",
    dataHandles: [],
    modelType,
    modelDef,
    evaluatedDefinition: definition,
    originalDefinition: definition,
    methodName: "deploy",
    reportGlobalArgs: {},
    reportMethodArgs: {},
    // The builtin method-summary is a model-type default candidate on
    // every run; skip it by default so tests control the applicable set.
    reportFilterOptions: { skipReportNames: ["@swamp/method-summary"] },
    repoDir: "/tmp/test-repo",
    runLogger: makeLogger(warnings),
    unifiedDataRepo: repo,
    definitionRepository: {} as unknown as DefinitionRepository,
    emitEvent: (event: WorkflowExecutionEvent) => {
      if (
        event.kind === "report_started" ||
        event.kind === "report_completed" ||
        event.kind === "report_failed"
      ) {
        events.push(event);
      }
    },
    jobName: "job-1",
    stepName: "step-1",
    ...overrides,
  };

  return { args, events, saved, warnings };
}

function makeDataHandle(overrides: Partial<DataHandle> = {}): DataHandle {
  return {
    name: "bucket-info",
    specName: "bucket",
    kind: "resource",
    dataId: generateDataId(),
    version: 3,
    size: 42,
    tags: { type: "resource" },
    metadata: {
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    },
    ...overrides,
  };
}

function requireReports(harness: Harness, names: string[]): void {
  const definition = Definition.create({
    type: "test/method-report-runner",
    name: `runner-model-${crypto.randomUUID()}`,
    reports: { require: names },
  });
  harness.args.evaluatedDefinition = definition;
  harness.args.originalDefinition = definition;
}

Deno.test("runFor: returns no artifacts when report filter options are absent", async () => {
  const harness = makeHarness({
    reportFilterOptions: undefined as unknown as ReportFilterOptions,
  });

  const refs = await new MethodReportRunner().runFor(harness.args);

  assertEquals(refs, []);
  assertEquals(harness.events, []);
  assertEquals(harness.saved, []);
});

Deno.test("runFor: succeeded run executes a required method-scope report and returns its artifact refs", async () => {
  const name = `@test/${crypto.randomUUID()}`;
  await withReports([{ name, report: makeReport("method") }], async () => {
    const harness = makeHarness();
    requireReports(harness, [name]);

    const refs = await new MethodReportRunner().runFor(harness.args);

    // Markdown + JSON artifacts, with the scoped name sanitized.
    const sanitized = name.replace(/@/g, "").replace(/\//g, "-");
    assertEquals(refs.length, 2);
    assertEquals(refs[0].name, `report-${sanitized}`);
    assertEquals(refs[1].name, `report-${sanitized}-json`);
    assertEquals(refs[0].version, 1);
    assertEquals(refs[0].tags.type, "report");
    assertEquals(refs[0].tags.reportName, name);

    // Persisted content matches the report result.
    assertEquals(harness.saved.length, 2);
    assertEquals(harness.saved[0].content, "# method");

    // Events carry job/step identity and the method scope.
    assertEquals(harness.events.length, 2);
    assertEquals(harness.events[0], {
      kind: "report_started",
      reportName: name,
      scope: "method",
      jobId: "job-1",
      stepId: "step-1",
    });
    assertEquals(harness.events[1].kind, "report_completed");
    assertEquals(harness.events[1].jobId, "job-1");
    assertEquals(harness.events[1].stepId, "step-1");
  });
});

Deno.test("runFor: succeeded run also executes required model-scope reports", async () => {
  const methodName = `@test/${crypto.randomUUID()}`;
  const modelName = `@test/${crypto.randomUUID()}`;
  let modelScopeSeen: string | undefined;
  await withReports([
    { name: methodName, report: makeReport("method") },
    {
      name: modelName,
      report: makeReport("model", (context) => {
        modelScopeSeen = (context as ModelReportContext).scope;
        return Promise.resolve({ markdown: "# model", json: {} });
      }),
    },
  ], async () => {
    const harness = makeHarness();
    requireReports(harness, [methodName, modelName]);

    const refs = await new MethodReportRunner().runFor(harness.args);

    // Two artifacts per report, both scopes.
    assertEquals(refs.length, 4);
    assertEquals(modelScopeSeen, "model");

    const scopes = harness.events
      .filter((e) => e.kind === "report_completed")
      .map((e) => e.scope)
      .sort();
    assertEquals(scopes, ["method", "model"]);
  });
});

Deno.test("runFor: builtin method-summary runs as a model-type default when not skipped", async () => {
  const harness = makeHarness({ reportFilterOptions: {} });

  const refs = await new MethodReportRunner().runFor(harness.args);

  assertEquals(refs.length, 2);
  assertEquals(refs[0].name, "report-swamp-method-summary");
  assertEquals(refs[1].name, "report-swamp-method-summary-json");

  const completed = harness.events.filter((e) => e.kind === "report_completed");
  assertEquals(completed.length, 1);
  assertEquals(completed[0].reportName, "@swamp/method-summary");
  assertStringIncludes(harness.saved[0].content, "deploy");
});

Deno.test("runFor: a failing report emits report_failed without sinking the run", async () => {
  const failingName = `@test/${crypto.randomUUID()}`;
  const goodName = `@test/${crypto.randomUUID()}`;
  await withReports([
    {
      name: failingName,
      report: makeReport("method", () => {
        throw new Error("report exploded");
      }),
    },
    { name: goodName, report: makeReport("method") },
  ], async () => {
    const harness = makeHarness();
    requireReports(harness, [failingName, goodName]);

    const refs = await new MethodReportRunner().runFor(harness.args);

    // The good report's artifacts plus the failing report's fallback
    // error artifacts are all surfaced into the run record.
    assertEquals(refs.length, 4);
    const goodSanitized = goodName.replace(/@/g, "").replace(/\//g, "-");
    const failSanitized = failingName.replace(/@/g, "").replace(/\//g, "-");
    const names = refs.map((r) => r.name).sort();
    assertEquals(
      names,
      [
        `report-${failSanitized}`,
        `report-${failSanitized}-json`,
        `report-${goodSanitized}`,
        `report-${goodSanitized}-json`,
      ].sort(),
    );

    const failed = harness.events.filter((e) => e.kind === "report_failed");
    assertEquals(failed.length, 1);
    assertEquals(failed[0].reportName, failingName);
    assertEquals(failed[0].error, "report exploded");

    // The other report still completed.
    const completed = harness.events.filter((e) =>
      e.kind === "report_completed"
    );
    assertEquals(completed.length, 1);
    assertEquals(completed[0].reportName, goodName);
  });
});

Deno.test("runFor: feeds the method execution context to the report", async () => {
  const name = `@test/${crypto.randomUUID()}`;
  const handle = makeDataHandle();
  let seen: MethodReportContext | undefined;
  await withReports([
    {
      name,
      report: makeReport("method", (context) => {
        seen = context as MethodReportContext;
        return Promise.resolve({ markdown: "# ctx", json: {} });
      }),
    },
  ], async () => {
    const harness = makeHarness({
      dataHandles: [handle],
      reportGlobalArgs: { region: "eu-west-1" },
      reportMethodArgs: { dryRun: true },
      swampSha: "abc123",
    });
    requireReports(harness, [name]);

    await new MethodReportRunner().runFor(harness.args);

    assertEquals(seen?.scope, "method");
    assertEquals(seen?.methodName, "deploy");
    assertEquals(seen?.executionStatus, "succeeded");
    assertEquals(seen?.errorMessage, undefined);
    assertEquals(seen?.dataHandles, [handle]);
    assertEquals(seen?.globalArgs, { region: "eu-west-1" });
    assertEquals(seen?.methodArgs, { dryRun: true });
    assertEquals(seen?.modelId, harness.args.evaluatedDefinition.id);
    assertEquals(seen?.definition.name, harness.args.evaluatedDefinition.name);
    assertEquals(seen?.repoDir, "/tmp/test-repo");
    assertEquals(seen?.swampSha, "abc123");
  });
});

Deno.test("runFor: failed run executes method-scope reports with the error and returns no artifacts", async () => {
  const name = `@test/${crypto.randomUUID()}`;
  let seen: MethodReportContext | undefined;
  await withReports([
    {
      name,
      report: makeReport("method", (context) => {
        seen = context as MethodReportContext;
        return Promise.resolve({ markdown: "# failure", json: {} });
      }),
    },
  ], async () => {
    const harness = makeHarness({
      status: "failed",
      errorMessage: "deploy blew up",
    });
    requireReports(harness, [name]);

    const refs = await new MethodReportRunner().runFor(harness.args);

    // The failure path never returns artifacts — the caller keeps the
    // original execution error as the outcome.
    assertEquals(refs, []);

    // But the report still ran with a structured failure context and
    // its artifacts were persisted.
    assertEquals(seen?.executionStatus, "failed");
    assertEquals(seen?.errorMessage, "deploy blew up");
    assertEquals(seen?.dataHandles, []);
    assertEquals(harness.saved.length, 2);

    const completed = harness.events.filter((e) =>
      e.kind === "report_completed"
    );
    assertEquals(completed.length, 1);
    assertEquals(completed[0].reportName, name);
  });
});

Deno.test("runFor: failed run does not execute model-scope reports", async () => {
  const methodName = `@test/${crypto.randomUUID()}`;
  const modelName = `@test/${crypto.randomUUID()}`;
  let modelExecuted = false;
  await withReports([
    { name: methodName, report: makeReport("method") },
    {
      name: modelName,
      report: makeReport("model", () => {
        modelExecuted = true;
        return Promise.resolve({ markdown: "# model", json: {} });
      }),
    },
  ], async () => {
    const harness = makeHarness({ status: "failed", errorMessage: "boom" });
    requireReports(harness, [methodName, modelName]);

    await new MethodReportRunner().runFor(harness.args);

    assertEquals(modelExecuted, false);
    assertEquals(
      harness.events.filter((e) => e.scope === "model"),
      [],
    );
  });
});

Deno.test("runFor: failed run swallows report machinery errors and warns", async () => {
  const name = `@test/${crypto.randomUUID()}`;
  await withReports([{ name, report: makeReport("method") }], async () => {
    const harness = makeHarness({ status: "failed", errorMessage: "boom" });
    requireReports(harness, [name]);
    harness.args.emitEvent = () => {
      throw new Error("event sink broken");
    };

    const refs = await new MethodReportRunner().runFor(harness.args);

    // The report machinery error is swallowed — the caller's original
    // execution error stays intact — and logged at warn.
    assertEquals(refs, []);
    assertEquals(harness.warnings.length, 1);
    assertStringIncludes(
      harness.warnings[0].template,
      "Failed to run reports for failed method",
    );
    assertEquals(harness.warnings[0].props?.error, "event sink broken");
  });
});

Deno.test("runFor: skipAllReports suppresses non-required reports entirely", async () => {
  const harness = makeHarness({
    reportFilterOptions: { skipAllReports: true },
  });

  const refs = await new MethodReportRunner().runFor(harness.args);

  assertEquals(refs, []);
  assertEquals(harness.events, []);
  assertEquals(harness.saved, []);
});

Deno.test("runFor: unresolvable required report fails once and surfaces error artifacts", async () => {
  const missing = `@test/missing-${crypto.randomUUID()}`;
  const harness = makeHarness();
  requireReports(harness, [missing]);

  const refs = await new MethodReportRunner().runFor(harness.args);

  // The failure error artifacts are collected into the run record.
  const sanitized = missing.replace(/@/g, "").replace(/\//g, "-");
  assertEquals(refs.length, 2);
  assertEquals(refs[0].name, `report-${sanitized}`);

  // The model-scope pass suppresses the duplicate failure emission.
  const failed = harness.events.filter((e) => e.kind === "report_failed");
  assertEquals(failed.length, 1);
  assertEquals(failed[0].reportName, missing);
  assertStringIncludes(failed[0].error, "Required report not found");
});

Deno.test("runFor: vary suffix is appended to report artifact names", async () => {
  const name = `@test/${crypto.randomUUID()}`;
  await withReports([{ name, report: makeReport("method") }], async () => {
    const harness = makeHarness({ reportVarySuffix: "eu-1" });
    requireReports(harness, [name]);

    const refs = await new MethodReportRunner().runFor(harness.args);

    const sanitized = name.replace(/@/g, "").replace(/\//g, "-");
    assertEquals(refs.length, 2);
    assertEquals(refs[0].name, `report-${sanitized}-eu-1`);
    assertEquals(refs[1].name, `report-${sanitized}-eu-1-json`);
    assertEquals(refs[0].tags.varySuffix, "eu-1");
  });
});
