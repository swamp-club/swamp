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

import { assertEquals, assertThrows } from "@std/assert";
import { type LazyReportEntry, ReportRegistry } from "./report_registry.ts";
import type { ReportDefinition } from "./report.ts";
import type { ReportContext } from "./report_context.ts";

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

Deno.test("ReportRegistry - register and get", () => {
  const registry = new ReportRegistry();
  const report = makeReport();
  registry.register("test-report", report);

  assertEquals(registry.get("test-report"), report);
  assertEquals(registry.has("test-report"), true);
  assertEquals(registry.has("nonexistent"), false);
  assertEquals(registry.get("nonexistent"), undefined);
});

Deno.test("ReportRegistry - duplicate registration throws", () => {
  const registry = new ReportRegistry();
  registry.register("test-report", makeReport());

  assertThrows(
    () => registry.register("test-report", makeReport()),
    Error,
    "Report already registered: test-report",
  );
});

Deno.test("ReportRegistry - getAll returns all reports", () => {
  const registry = new ReportRegistry();
  registry.register("report-a", makeReport("method"));
  registry.register("report-b", makeReport("model"));
  registry.register("report-c", makeReport("workflow"));

  const all = registry.getAll();
  assertEquals(all.length, 3);
  assertEquals(all.map((r) => r.name).sort(), [
    "report-a",
    "report-b",
    "report-c",
  ]);
});

Deno.test("ReportRegistry - getByScope filters by scope", () => {
  const registry = new ReportRegistry();
  registry.register("method-1", makeReport("method"));
  registry.register("method-2", makeReport("method"));
  registry.register("model-1", makeReport("model"));
  registry.register("workflow-1", makeReport("workflow"));

  const methodReports = registry.getByScope("method");
  assertEquals(methodReports.length, 2);
  assertEquals(
    methodReports.map((r) => r.name).sort(),
    ["method-1", "method-2"],
  );

  const modelReports = registry.getByScope("model");
  assertEquals(modelReports.length, 1);
  assertEquals(modelReports[0].name, "model-1");

  const workflowReports = registry.getByScope("workflow");
  assertEquals(workflowReports.length, 1);
  assertEquals(workflowReports[0].name, "workflow-1");
});

// --- Lazy loading tests ---

function createLazyReportEntry(type: string): LazyReportEntry {
  return {
    type,
    bundlePath: `/repo/.swamp/report-bundles/${type}.js`,
    sourcePath: `/repo/extensions/reports/${type}.ts`,
    version: "2026.01.15.1",
  };
}

Deno.test("ReportRegistry.registerLazy: stores lazy entries without importing", () => {
  const registry = new ReportRegistry();
  registry.registerLazy(createLazyReportEntry("@myorg/custom-report"));

  assertEquals(registry.has("@myorg/custom-report"), true);
  assertEquals(registry.isLazy("@myorg/custom-report"), true);
  assertEquals(registry.get("@myorg/custom-report"), undefined);
});

Deno.test("ReportRegistry.ensureTypeLoaded: calls type loader for lazy types", async () => {
  const registry = new ReportRegistry();
  registry.registerLazy(createLazyReportEntry("@myorg/custom-report"));

  let loadedType: string | null = null;
  registry.setTypeLoader((type) => {
    loadedType = type;
    registry.promoteFromLazy(type, makeReport("method"));
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/custom-report");

  assertEquals(loadedType, "@myorg/custom-report");
  assertEquals(registry.isLazy("@myorg/custom-report"), false);
  assertEquals(registry.get("@myorg/custom-report")?.scope, "method");
});

Deno.test("ReportRegistry.ensureTypeLoaded: no-op for already loaded types", async () => {
  const registry = new ReportRegistry();
  registry.register("@myorg/loaded", makeReport());

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/loaded");
  assertEquals(called, false);
});

Deno.test("ReportRegistry.ensureTypeLoaded: no-op for unknown types", async () => {
  const registry = new ReportRegistry();

  let called = false;
  registry.setTypeLoader(() => {
    called = true;
    return Promise.resolve();
  });

  await registry.ensureTypeLoaded("@myorg/nonexistent");
  assertEquals(called, false);
});

Deno.test("ReportRegistry.ensureTypeLoaded: concurrent callers share same promise", async () => {
  const registry = new ReportRegistry();
  registry.registerLazy(createLazyReportEntry("@myorg/custom-report"));

  let callCount = 0;
  registry.setTypeLoader(async (type) => {
    callCount++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    registry.promoteFromLazy(type, makeReport());
  });

  await Promise.all([
    registry.ensureTypeLoaded("@myorg/custom-report"),
    registry.ensureTypeLoaded("@myorg/custom-report"),
    registry.ensureTypeLoaded("@myorg/custom-report"),
  ]);

  assertEquals(callCount, 1);
});

Deno.test("ReportRegistry.ensureTypeLoaded: retries after transient failure", async () => {
  const registry = new ReportRegistry();
  registry.registerLazy(createLazyReportEntry("@myorg/custom-report"));

  let callCount = 0;
  registry.setTypeLoader((type) => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject(new Error("transient I/O error"));
    }
    registry.promoteFromLazy(type, makeReport());
    return Promise.resolve();
  });

  let caught = false;
  try {
    await registry.ensureTypeLoaded("@myorg/custom-report");
  } catch {
    caught = true;
  }
  assertEquals(caught, true);

  await registry.ensureTypeLoaded("@myorg/custom-report");
  assertEquals(callCount, 2);
  assertEquals(registry.get("@myorg/custom-report")?.scope, "method");
});
