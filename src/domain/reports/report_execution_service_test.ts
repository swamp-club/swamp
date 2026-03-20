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
