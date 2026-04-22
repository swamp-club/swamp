// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  executeReports,
  filterReports,
  sanitizeReportNameForData,
} from "./report_execution_service.ts";
import type { ReportDefinition } from "./report.ts";
import type { ReportContext } from "./report_context.ts";
import type { ReportSelection } from "./report_selection.ts";
import type { ReportFilterOptions } from "./report_execution_service.ts";
import { ReportRegistry } from "./report_registry.ts";
import type { MethodReportContext } from "./report_context.ts";
import { ModelType } from "../models/model_type.ts";
import type { DataHandle } from "../models/model.ts";
import { generateDataId } from "../data/mod.ts";

function makeReport(
  scope: "method" | "model" | "workflow" = "method",
  labels?: string[],
): ReportDefinition {
  return {
    description: `Test ${scope} report`,
    scope,
    labels,
    execute(_context: ReportContext) {
      return Promise.resolve({ markdown: "# Test", json: { test: true } });
    },
  };
}

function makeReportEntry(
  name: string,
  scope: "method" | "model" | "workflow" = "method",
  labels?: string[],
) {
  return { name, report: makeReport(scope, labels) };
}

Deno.test("filterReports - returns model-type default reports when provided", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const result = filterReports(
    reports,
    "method",
    undefined,
    {},
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 2);
});

Deno.test("filterReports - only model-type defaults are candidates", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
    makeReportEntry("c", "method"),
  ];
  // Only "a" and "b" are model-type defaults, "c" should be excluded
  const result = filterReports(
    reports,
    "method",
    undefined,
    {},
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 2);
  assertEquals(result.map((r) => r.name).sort(), ["a", "b"]);
});

Deno.test("filterReports - without modelTypeReports only require are candidates", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  // No model-type defaults and no require = no candidates (workflow scope behavior)
  const result = filterReports(reports, "method", undefined, {});
  assertEquals(result.length, 0);
});

Deno.test("filterReports - require adds to candidates without modelTypeReports", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const selection: ReportSelection = {
    require: ["a"],
  };
  // Only "a" is in require, so only "a" is a candidate
  const result = filterReports(reports, "method", selection, {});
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "a");
});

Deno.test("filterReports - filters by scope", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "model"),
    makeReportEntry("c", "workflow"),
  ];
  const result = filterReports(
    reports,
    "method",
    undefined,
    {},
    undefined,
    ["a", "b", "c"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "a");
});

Deno.test("filterReports - definition-level skip always wins", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const selection: ReportSelection = {
    skip: ["a"],
  };
  const result = filterReports(
    reports,
    "method",
    selection,
    {},
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "b");
});

Deno.test("filterReports - definition-level skip wins over require", () => {
  const reports = [
    makeReportEntry("a", "method"),
  ];
  const selection: ReportSelection = {
    require: ["a"],
    skip: ["a"],
  };
  const result = filterReports(
    reports,
    "method",
    selection,
    {},
    undefined,
    ["a"],
  );
  assertEquals(result.length, 0);
});

Deno.test("filterReports - required reports immune to CLI skip flags", () => {
  const reports = [
    makeReportEntry("a", "method", ["cost"]),
    makeReportEntry("b", "method", ["cost"]),
  ];
  const selection: ReportSelection = {
    require: ["a"],
  };
  const filter: ReportFilterOptions = {
    skipReportNames: ["a"],
    skipReportLabels: ["cost"],
  };
  const result = filterReports(
    reports,
    "method",
    selection,
    filter,
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "a");
});

Deno.test("filterReports - skipAllReports still allows required", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const selection: ReportSelection = {
    require: ["a"],
  };
  const filter: ReportFilterOptions = {
    skipAllReports: true,
  };
  const result = filterReports(
    reports,
    "method",
    selection,
    filter,
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "a");
});

Deno.test("filterReports - CLI skip by name", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const filter: ReportFilterOptions = {
    skipReportNames: ["a"],
  };
  const result = filterReports(
    reports,
    "method",
    undefined,
    filter,
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "b");
});

Deno.test("filterReports - CLI skip by label", () => {
  const reports = [
    makeReportEntry("a", "method", ["cost"]),
    makeReportEntry("b", "method", ["audit"]),
  ];
  const filter: ReportFilterOptions = {
    skipReportLabels: ["cost"],
  };
  const result = filterReports(
    reports,
    "method",
    undefined,
    filter,
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "b");
});

Deno.test("filterReports - inclusion filter by name", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
    makeReportEntry("c", "method"),
  ];
  const filter: ReportFilterOptions = {
    reportNames: ["b"],
  };
  const result = filterReports(
    reports,
    "method",
    undefined,
    filter,
    undefined,
    ["a", "b", "c"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "b");
});

Deno.test("filterReports - inclusion filter by label", () => {
  const reports = [
    makeReportEntry("a", "method", ["cost"]),
    makeReportEntry("b", "method", ["audit"]),
    makeReportEntry("c", "method", ["cost", "audit"]),
  ];
  const filter: ReportFilterOptions = {
    reportLabels: ["cost"],
  };
  const result = filterReports(
    reports,
    "method",
    undefined,
    filter,
    undefined,
    ["a", "b", "c"],
  );
  assertEquals(result.length, 2);
  assertEquals(result.map((r) => r.name).sort(), ["a", "c"]);
});

Deno.test("filterReports - method scoping from YAML", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const selection: ReportSelection = {
    require: [
      { name: "a", methods: ["create", "update"] },
      "b",
    ],
  };
  // Running "delete" method - "a" should be excluded, "b" included
  const result = filterReports(
    reports,
    "method",
    selection,
    {},
    "delete",
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "b");
});

Deno.test("filterReports - method scoping includes matching method", () => {
  const reports = [
    makeReportEntry("a", "method"),
  ];
  const selection: ReportSelection = {
    require: [{ name: "a", methods: ["create", "update"] }],
  };
  const result = filterReports(
    reports,
    "method",
    selection,
    {},
    "create",
    ["a"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "a");
});

Deno.test("filterReports - require adds reports beyond model-type defaults", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
    makeReportEntry("c", "method"),
  ];
  const selection: ReportSelection = {
    require: ["c"],
  };
  // Model-type defaults are "a" and "b", require adds "c"
  const result = filterReports(
    reports,
    "method",
    selection,
    {},
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 3);
  assertEquals(result.map((r) => r.name).sort(), ["a", "b", "c"]);
});

Deno.test("filterReports - skip removes from model-type defaults", () => {
  const reports = [
    makeReportEntry("a", "method"),
    makeReportEntry("b", "method"),
  ];
  const selection: ReportSelection = {
    skip: ["a"],
  };
  const result = filterReports(
    reports,
    "method",
    selection,
    {},
    undefined,
    ["a", "b"],
  );
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "b");
});

Deno.test("sanitizeReportNameForData - strips @ and replaces / with -", () => {
  assertEquals(
    sanitizeReportNameForData("@adam/cfgmgmt-workflow-summary"),
    "adam-cfgmgmt-workflow-summary",
  );
});

Deno.test("sanitizeReportNameForData - handles backslashes", () => {
  assertEquals(
    sanitizeReportNameForData("@org\\report"),
    "org-report",
  );
});

Deno.test("sanitizeReportNameForData - collapses double dots", () => {
  assertEquals(
    sanitizeReportNameForData("foo..bar"),
    "foo.bar",
  );
});

Deno.test("sanitizeReportNameForData - strips null bytes", () => {
  assertEquals(
    sanitizeReportNameForData("foo\0bar"),
    "foobar",
  );
});

Deno.test("sanitizeReportNameForData - passes through simple names unchanged", () => {
  assertEquals(
    sanitizeReportNameForData("cost-report"),
    "cost-report",
  );
});

Deno.test("sanitizeReportNameForData - handles nested path report names", () => {
  assertEquals(
    sanitizeReportNameForData("@webframp/aws/cost-report"),
    "webframp-aws-cost-report",
  );
});

// --- executeReports with varySuffix tests ---

/**
 * Creates a minimal in-memory data repository for testing report persistence.
 */
function createInMemoryDataRepo() {
  const saved: Array<{
    name: string;
    tags: Record<string, string>;
    content: string;
  }> = [];

  return {
    repo: {
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
      findAllForModel: () => Promise.resolve([]),
      findAllGlobal: () => Promise.resolve([]),
      findById: () => Promise.resolve(null),
      append: () => Promise.resolve(),
      stream: async function* () {},
      getContent: () => Promise.resolve(null),
      getPath: () => "",
      getContentPath: () => "",
      delete: () => Promise.resolve(),
      deleteVersion: () => Promise.resolve(),
      gc: () => Promise.resolve({ deleted: 0 }),
    },
    saved,
  };
}

Deno.test("executeReports - varySuffix appends to data names", async () => {
  const registry = new ReportRegistry();
  registry.register("test-report", makeReport("method"));

  const { repo, saved } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  const selection: ReportSelection = { require: ["test-report"] };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    selection,
    {},
    undefined,
    "run",
    undefined,
    "iteration-1",
  );

  // Should have saved 2 artifacts (markdown + json) with varySuffix in name
  assertEquals(saved.length, 2);
  assertStringIncludes(saved[0].name, "iteration-1");
  assertStringIncludes(saved[1].name, "iteration-1");
  assertEquals(saved[0].name, "report-test-report-iteration-1");
  assertEquals(saved[1].name, "report-test-report-iteration-1-json");
});

Deno.test("executeReports - varySuffix included as tag", async () => {
  const registry = new ReportRegistry();
  registry.register("tag-test", makeReport("method"));

  const { repo, saved } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["tag-test"] },
    {},
    undefined,
    "run",
    undefined,
    "dev",
  );

  assertEquals(saved[0].tags.varySuffix, "dev");
  assertEquals(saved[1].tags.varySuffix, "dev");
});

Deno.test("executeReports - without varySuffix uses base name", async () => {
  const registry = new ReportRegistry();
  registry.register("no-vary", makeReport("method"));

  const { repo, saved } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["no-vary"] },
    {},
    undefined,
    "run",
  );

  assertEquals(saved[0].name, "report-no-vary");
  assertEquals(saved[1].name, "report-no-vary-json");
  assertEquals(saved[0].tags.varySuffix, undefined);
});

Deno.test("executeReports - varySuffix with scoped report name sanitization", async () => {
  const registry = new ReportRegistry();
  registry.register("@adam/state-report", makeReport("method"));

  const { repo, saved } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["@adam/state-report"] },
    {},
    undefined,
    "run",
    undefined,
    "2",
  );

  // @adam/state-report → sanitized to "adam-state-report", plus varySuffix "2"
  assertEquals(saved[0].name, "report-adam-state-report-2");
  assertEquals(saved[1].name, "report-adam-state-report-2-json");
});

Deno.test("executeReports - events include varySuffix data handles", async () => {
  const registry = new ReportRegistry();
  registry.register("event-test", makeReport("method"));

  const { repo } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  const completedHandles: DataHandle[][] = [];
  const events = {
    onReportStarted: () => {},
    onReportCompleted: (
      _name: string,
      _scope: string,
      _markdown: string,
      _json: Record<string, unknown>,
      dataHandles: DataHandle[],
    ) => {
      completedHandles.push(dataHandles);
    },
    onReportFailed: () => {},
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["event-test"] },
    {},
    events,
    "run",
    undefined,
    "host-a",
  );

  assertEquals(completedHandles.length, 1);
  const handles = completedHandles[0];
  assertEquals(handles.length, 2);
  assertStringIncludes(handles[0].name, "host-a");
  assertStringIncludes(handles[1].name, "host-a");
});

// --- buildRedactSensitiveArgs tests (via executeReports) ---

import type { WorkflowReportContext } from "./report_context.ts";
import { modelRegistry } from "../models/model.ts";
import { z } from "zod";

/**
 * Creates a report that captures the redactSensitiveArgs function from its
 * context and applies it to the provided args, returning the results.
 */
function makeRedactionCapturingReport(
  globalArgs: Record<string, unknown>,
  methodArgs: Record<string, unknown>,
): {
  report: ReportDefinition;
  getResults: () => {
    redactedGlobal: Record<string, unknown>;
    redactedMethod: Record<string, unknown>;
  } | null;
} {
  let capturedResults: {
    redactedGlobal: Record<string, unknown>;
    redactedMethod: Record<string, unknown>;
  } | null = null;

  const report: ReportDefinition = {
    description: "Captures redactSensitiveArgs behavior",
    scope: "method",
    execute(context: ReportContext) {
      if (context.scope !== "method") {
        throw new Error("Expected method context");
      }
      const redact = context.redactSensitiveArgs;
      capturedResults = {
        redactedGlobal: redact ? redact(globalArgs, "global") : globalArgs,
        redactedMethod: redact ? redact(methodArgs, "method") : methodArgs,
      };
      return Promise.resolve({
        markdown: "# Redaction Test",
        json: capturedResults,
      });
    },
  };

  return { report, getResults: () => capturedResults };
}

/**
 * Registers a temporary model type with sensitive fields for testing.
 * Uses a unique type name to avoid conflicts with other tests.
 */
function registerSensitiveModel(suffix: string): ModelType {
  const typeName = `@test-redact/sensitive-${suffix}`;
  const modelType = ModelType.create(typeName);
  if (!modelRegistry.has(modelType)) {
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        region: z.string(),
        apiKey: z.string().meta({ sensitive: true }),
      }),
      methods: {
        deploy: {
          description: "test deploy",
          arguments: z.object({
            target: z.string(),
            password: z.string().meta({ sensitive: true }),
          }),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });
  }
  return modelType;
}

Deno.test("buildRedactSensitiveArgs: redacts sensitive global args", async () => {
  const modelType = registerSensitiveModel("global");
  const globalArgs = { region: "us-east-1", apiKey: "sk-secret-12345" };
  const methodArgs = { target: "prod", password: "hunter2" };
  const { report, getResults } = makeRedactionCapturingReport(
    globalArgs,
    methodArgs,
  );

  const registry = new ReportRegistry();
  registry.register("redaction-test-global", report);

  const { repo } = createInMemoryDataRepo();

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs,
    methodArgs,
    methodName: "deploy",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["redaction-test-global"] },
    {},
    undefined,
    "deploy",
  );

  const results = getResults();
  assertEquals(results !== null, true);
  assertEquals(results!.redactedGlobal.apiKey, "***");
  assertEquals(results!.redactedGlobal.region, "us-east-1");
});

Deno.test("buildRedactSensitiveArgs: redacts sensitive method args", async () => {
  const modelType = registerSensitiveModel("method");
  const globalArgs = { region: "us-east-1", apiKey: "sk-secret-12345" };
  const methodArgs = { target: "prod", password: "hunter2" };
  const { report, getResults } = makeRedactionCapturingReport(
    globalArgs,
    methodArgs,
  );

  const registry = new ReportRegistry();
  registry.register("redaction-test-method", report);

  const { repo } = createInMemoryDataRepo();

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs,
    methodArgs,
    methodName: "deploy",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["redaction-test-method"] },
    {},
    undefined,
    "deploy",
  );

  const results = getResults();
  assertEquals(results !== null, true);
  assertEquals(results!.redactedMethod.password, "***");
  assertEquals(results!.redactedMethod.target, "prod");
});

Deno.test("buildRedactSensitiveArgs: returns args unchanged for model without sensitive fields", async () => {
  const typeName = "@test-redact/no-sensitive";
  const modelType = ModelType.create(typeName);
  if (!modelRegistry.has(modelType)) {
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        region: z.string(),
      }),
      methods: {
        run: {
          description: "test run",
          arguments: z.object({
            target: z.string(),
          }),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });
  }

  const globalArgs = { region: "us-east-1" };
  const methodArgs = { target: "prod" };
  const { report, getResults } = makeRedactionCapturingReport(
    globalArgs,
    methodArgs,
  );

  const registry = new ReportRegistry();
  registry.register("redaction-test-none", report);

  const { repo } = createInMemoryDataRepo();

  const context: MethodReportContext = {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs,
    methodArgs,
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["redaction-test-none"] },
    {},
    undefined,
    "run",
  );

  const results = getResults();
  assertEquals(results !== null, true);
  assertEquals(results!.redactedGlobal.region, "us-east-1");
  assertEquals(results!.redactedMethod.target, "prod");
});

Deno.test("buildRedactSensitiveArgs: returns args unchanged for workflow scope", async () => {
  const typeName = "@test-redact/workflow-scope";
  const modelType = ModelType.create(typeName);
  if (!modelRegistry.has(modelType)) {
    modelRegistry.register({
      type: modelType,
      version: "2026.01.01.1",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
      }),
      methods: {
        run: {
          description: "test",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });
  }

  const globalArgs = { apiKey: "sk-secret" };
  let capturedResult: Record<string, unknown> | null = null;

  const workflowReport: ReportDefinition = {
    description: "Workflow scope redaction test",
    scope: "workflow",
    execute(context: ReportContext) {
      const redact = context.redactSensitiveArgs;
      capturedResult = redact ? redact(globalArgs, "global") : globalArgs;
      return Promise.resolve({
        markdown: "# Test",
        json: capturedResult,
      });
    },
  };

  const registry = new ReportRegistry();
  registry.register("wf-redact-test", workflowReport);

  const { repo } = createInMemoryDataRepo();

  const context: WorkflowReportContext = {
    scope: "workflow",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as WorkflowReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    workflowId: "wf-1",
    workflowRunId: "run-1",
    workflowName: "test-workflow",
    workflowStatus: "succeeded",
    stepExecutions: [],
  };

  await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["wf-redact-test"] },
    {},
    undefined,
    undefined,
    undefined,
  );

  // Workflow scope should return args unchanged (no redaction)
  assertEquals(capturedResult !== null, true);
  assertEquals(capturedResult!.apiKey, "sk-secret");
});

// --- executeReports lazy-report promotion tests (regression: #81) ---

/**
 * Builds a minimal MethodReportContext for lazy-promotion tests.
 */
function makeMethodContext(
  repo: ReturnType<typeof createInMemoryDataRepo>["repo"],
  modelType: ModelType,
): MethodReportContext {
  return {
    scope: "method",
    repoDir: "/tmp/test",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    } as unknown as MethodReportContext["logger"],
    // deno-lint-ignore no-explicit-any
    dataRepository: repo as any,
    // deno-lint-ignore no-explicit-any
    definitionRepository: {} as any,
    modelType,
    modelId: "test-id",
    definition: { id: "test-id", name: "test", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    methodName: "run",
    executionStatus: "succeeded",
    dataHandles: [],
    extensionFile: () => {
      throw new Error("extensionFile not stubbed in this test");
    },
  };
}

/**
 * Creates a fresh ReportRegistry with a single lazy entry and a type loader
 * that promotes it on demand. Returns the registry and a counter for the
 * number of times the loader was invoked.
 */
function createRegistryWithLazyReport(
  typeName: string,
  scope: "method" | "model" | "workflow" = "method",
): { registry: ReportRegistry; loaderCallCount: { value: number } } {
  const registry = new ReportRegistry();
  registry.registerLazy({
    type: typeName,
    bundlePath: `/tmp/fake-bundles/${typeName}.js`,
    sourcePath: `/tmp/fake-sources/${typeName}.ts`,
    version: "2026.04.11.1",
  });

  const loaderCallCount = { value: 0 };
  registry.setTypeLoader((type) => {
    loaderCallCount.value++;
    registry.promoteFromLazy(type, makeReport(scope));
    return Promise.resolve();
  });

  return { registry, loaderCallCount };
}

Deno.test("executeReports: promotes lazy report named in selection.require", async () => {
  const { registry, loaderCallCount } = createRegistryWithLazyReport(
    "@test/lazy-method",
  );
  const { repo, saved } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");
  const context = makeMethodContext(repo, modelType);

  const summary = await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["@test/lazy-method"] },
    {},
    undefined,
    "run",
    undefined,
  );

  assertEquals(loaderCallCount.value, 1);
  assertEquals(summary.failures, 0);
  assertEquals(summary.results.length, 1);
  assertEquals(summary.results[0].name, "@test/lazy-method");
  assertEquals(summary.results[0].success, true);
  // Persisted two artifacts (markdown + json)
  assertEquals(saved.length, 2);
  assertStringIncludes(saved[0].name, "test-lazy-method");
});

Deno.test("executeReports: promotes lazy report from modelTypeReports defaults", async () => {
  const { registry, loaderCallCount } = createRegistryWithLazyReport(
    "@test/lazy-default",
  );
  const { repo } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");
  const context = makeMethodContext(repo, modelType);

  const summary = await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    undefined,
    {},
    undefined,
    "run",
    ["@test/lazy-default"],
  );

  assertEquals(loaderCallCount.value, 1);
  assertEquals(summary.failures, 0);
  assertEquals(summary.results.length, 1);
  assertEquals(summary.results[0].name, "@test/lazy-default");
  assertEquals(summary.results[0].success, true);
});

Deno.test("executeReports: handles ReportRef object form in require", async () => {
  const { registry, loaderCallCount } = createRegistryWithLazyReport(
    "@test/lazy-ref",
  );
  const { repo } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");
  const context = makeMethodContext(repo, modelType);

  const summary = await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: [{ name: "@test/lazy-ref", methods: ["run"] }] },
    {},
    undefined,
    "run",
    undefined,
  );

  assertEquals(loaderCallCount.value, 1);
  assertEquals(summary.results.length, 1);
  assertEquals(summary.results[0].name, "@test/lazy-ref");
  assertEquals(summary.results[0].success, true);
});

Deno.test("executeReports: ensureTypeLoaded failure fails loudly", async () => {
  const registry = new ReportRegistry();
  registry.registerLazy({
    type: "@test/lazy-broken",
    bundlePath: "/tmp/fake-bundles/broken.js",
    sourcePath: "/tmp/fake-sources/broken.ts",
    version: "2026.04.11.1",
  });
  registry.setTypeLoader(() => {
    return Promise.reject(new Error("bundle import failed"));
  });

  const { repo } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");
  const context = makeMethodContext(repo, modelType);

  let caught: Error | undefined;
  try {
    await executeReports(
      registry,
      context,
      modelType,
      "test-id",
      { require: ["@test/lazy-broken"] },
      {},
      undefined,
      "run",
      undefined,
    );
  } catch (err) {
    caught = err as Error;
  }

  assertEquals(caught !== undefined, true);
  assertStringIncludes(caught!.message, "bundle import failed");
});

Deno.test("executeReports: already-loaded reports are not re-promoted", async () => {
  const registry = new ReportRegistry();
  registry.register("@test/already-loaded", makeReport("method"));

  let loaderCalled = false;
  registry.setTypeLoader(() => {
    loaderCalled = true;
    return Promise.reject(new Error("type loader should not be called"));
  });

  const { repo } = createInMemoryDataRepo();
  const modelType = ModelType.create("test/model");
  const context = makeMethodContext(repo, modelType);

  const summary = await executeReports(
    registry,
    context,
    modelType,
    "test-id",
    { require: ["@test/already-loaded"] },
    {},
    undefined,
    "run",
    undefined,
  );

  assertEquals(loaderCalled, false);
  assertEquals(summary.results.length, 1);
  assertEquals(summary.results[0].success, true);
});
