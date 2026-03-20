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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { reportSearch } from "./search.ts";
import type { ReportSearchDeps } from "./search.ts";
import { Data } from "../../domain/data/data.ts";
import { ModelType } from "../../domain/models/model_type.ts";

function makeReportData(
  name: string,
  reportName: string,
  scope: string,
  contentType = "text/markdown",
): Data {
  return Data.create({
    name,
    contentType,
    lifetime: "30d",
    garbageCollection: 5,
    tags: { type: "report", reportName, reportScope: scope },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    createdAt: new Date("2026-01-15T10:00:00Z"),
  });
}

function makeDeps(
  globalData: Array<{
    data: Data;
    modelType: ModelType;
    modelId: string;
  }> = [],
): ReportSearchDeps {
  return {
    findAllGlobal: () => Promise.resolve(globalData),
    findAllForModel: (_type: ModelType, _modelId: string) =>
      Promise.resolve([] as Data[]),
    lookupDefinition: () => Promise.resolve(null),
    lookupDefinitionById: () => Promise.resolve(null),
    findWorkflowByName: () => Promise.resolve(null),
    findWorkflowById: () => Promise.resolve(null),
    getReport: () => undefined,
  };
}

Deno.test("reportSearch - returns empty when no reports exist", async () => {
  const ctx = createLibSwampContext();
  const deps = makeDeps([]);

  const events = await collect(reportSearch(ctx, deps, {}));
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reports.length, 0);
  }
});

Deno.test("reportSearch - finds markdown report entries", async () => {
  const modelType = ModelType.create("aws/ec2");
  const mdData = makeReportData("report-cost", "cost-report", "model");
  const jsonData = makeReportData(
    "report-cost-json",
    "cost-report",
    "model",
    "application/json",
  );

  const deps = makeDeps([
    { data: mdData, modelType, modelId: "test-id" },
    { data: jsonData, modelType, modelId: "test-id" },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(reportSearch(ctx, deps, {}));
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    // Should only return markdown entries, not JSON pairs
    assertEquals(last.data.reports.length, 1);
    assertEquals(last.data.reports[0].reportName, "cost-report");
    assertEquals(last.data.reports[0].reportScope, "model");
  }
});

Deno.test("reportSearch - filters by scope", async () => {
  const modelType = ModelType.create("aws/ec2");
  const methodReport = makeReportData(
    "report-method",
    "method-report",
    "method",
  );
  const modelReport = makeReportData(
    "report-model",
    "model-report",
    "model",
  );

  const deps = makeDeps([
    { data: methodReport, modelType, modelId: "test-id" },
    { data: modelReport, modelType, modelId: "test-id" },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(
    reportSearch(ctx, deps, { scope: "method" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reports.length, 1);
    assertEquals(last.data.reports[0].reportName, "method-report");
  }
});

Deno.test("reportSearch - filters by query", async () => {
  const modelType = ModelType.create("aws/ec2");
  const costReport = makeReportData("report-cost", "cost-report", "model");
  const secReport = makeReportData(
    "report-security",
    "security-report",
    "model",
  );

  const deps = makeDeps([
    { data: costReport, modelType, modelId: "test-id" },
    { data: secReport, modelType, modelId: "test-id" },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(
    reportSearch(ctx, deps, { query: "cost" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reports.length, 1);
    assertEquals(last.data.reports[0].reportName, "cost-report");
  }
});

Deno.test("reportSearch - populates varySuffix from tags", async () => {
  const modelType = ModelType.create("aws/ec2");
  const data = Data.create({
    name: "report-cost",
    contentType: "text/markdown",
    lifetime: "30d",
    garbageCollection: 5,
    tags: {
      type: "report",
      reportName: "cost-report",
      reportScope: "model",
      varySuffix: "10.0.0.1",
    },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    createdAt: new Date("2026-01-15T10:00:00Z"),
  });

  const deps = makeDeps([{ data, modelType, modelId: "test-id" }]);
  const ctx = createLibSwampContext();
  const events = await collect(reportSearch(ctx, deps, {}));
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reports[0].varySuffix, "10.0.0.1");
  }
});

Deno.test("reportSearch - varySuffix is undefined when not in tags", async () => {
  const modelType = ModelType.create("aws/ec2");
  const data = makeReportData("report-cost", "cost-report", "model");

  const deps = makeDeps([{ data, modelType, modelId: "test-id" }]);
  const ctx = createLibSwampContext();
  const events = await collect(reportSearch(ctx, deps, {}));
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reports[0].varySuffix, undefined);
  }
});

Deno.test("reportSearch - query filter matches varySuffix", async () => {
  const modelType = ModelType.create("aws/ec2");
  const dataWithSuffix = Data.create({
    name: "report-cost",
    contentType: "text/markdown",
    lifetime: "30d",
    garbageCollection: 5,
    tags: {
      type: "report",
      reportName: "cost-report",
      reportScope: "model",
      varySuffix: "10.0.0.1",
    },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    createdAt: new Date("2026-01-15T10:00:00Z"),
  });
  const dataWithout = makeReportData(
    "report-security",
    "security-report",
    "model",
  );

  const deps = makeDeps([
    { data: dataWithSuffix, modelType, modelId: "test-id" },
    { data: dataWithout, modelType, modelId: "test-id" },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(
    reportSearch(ctx, deps, { query: "10.0.0.1" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reports.length, 1);
    assertEquals(last.data.reports[0].varySuffix, "10.0.0.1");
  }
});

Deno.test("reportSearch - errors when model not found", async () => {
  const deps = makeDeps([]);
  const ctx = createLibSwampContext();

  const events = await collect(
    reportSearch(ctx, deps, { model: "nonexistent" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "not_found");
  }
});

Deno.test("reportSearch - errors when workflow not found", async () => {
  const deps = makeDeps([]);
  const ctx = createLibSwampContext();

  const events = await collect(
    reportSearch(ctx, deps, { workflow: "nonexistent" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "not_found");
  }
});
