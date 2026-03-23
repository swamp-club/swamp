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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import { reportGet } from "./get.ts";
import type { ReportGetDeps } from "./get.ts";
import { Data } from "../../domain/data/data.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { Definition } from "../../domain/definitions/definition.ts";

function makeReportData(
  name: string,
  reportName: string,
  scope: string,
): Data {
  return Data.create({
    name,
    contentType: "text/markdown",
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
): ReportGetDeps {
  return {
    findAllGlobal: () => Promise.resolve(globalData),
    findAllForModel: (_type: ModelType, _modelId: string) =>
      Promise.resolve([] as Data[]),
    getContent: (
      _type: ModelType,
      _modelId: string,
      dataName: string,
    ) => {
      if (dataName.endsWith("-json")) {
        return Promise.resolve(
          new TextEncoder().encode('{"status":"ok"}'),
        );
      }
      return Promise.resolve(
        new TextEncoder().encode("# Report\nAll good."),
      );
    },
    lookupDefinition: () => Promise.resolve(null),
    lookupDefinitionById: () => Promise.resolve(null),
    findWorkflowByName: () => Promise.resolve(null),
    findWorkflowById: () => Promise.resolve(null),
  };
}

Deno.test("reportGet - returns stored report content", async () => {
  const modelType = ModelType.create("aws/ec2");
  const reportData = makeReportData("report-cost", "cost-report", "model");

  const deps = makeDeps([
    { data: reportData, modelType, modelId: "test-id" },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(
    reportGet(ctx, deps, { reportName: "cost-report" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reportName, "cost-report");
    assertEquals(last.data.reportScope, "model");
    assertEquals(last.data.markdown, "# Report\nAll good.");
    assertEquals(last.data.json, { status: "ok" });
  }
});

Deno.test("reportGet - errors when report not found", async () => {
  const deps = makeDeps([]);
  const ctx = createLibSwampContext();

  const events = await collect(
    reportGet(ctx, deps, { reportName: "nonexistent" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "not_found");
  }
});

Deno.test("reportGet - errors on ambiguous report across models", async () => {
  const modelType = ModelType.create("aws/ec2");
  const report1 = makeReportData("report-cost", "cost-report", "model");
  const report2 = makeReportData("report-cost", "cost-report", "model");

  const def1 = Definition.create({ name: "model-a", type: "aws/ec2" });
  const def2 = Definition.create({ name: "model-b", type: "aws/ec2" });

  const deps: ReportGetDeps = {
    ...makeDeps(),
    findAllGlobal: () =>
      Promise.resolve([
        { data: report1, modelType, modelId: def1.id },
        { data: report2, modelType, modelId: def2.id },
      ]),
    lookupDefinitionById: (_type: ModelType, id: string) => {
      if (id === def1.id) return Promise.resolve(def1);
      if (id === def2.id) return Promise.resolve(def2);
      return Promise.resolve(null);
    },
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    reportGet(ctx, deps, { reportName: "cost-report" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "validation_failed");
  }
});

Deno.test("reportGet - resolves with --model when ambiguous", async () => {
  const modelType = ModelType.create("aws/ec2");
  const reportData = makeReportData("report-cost", "cost-report", "model");
  const def = Definition.create({ name: "my-model", type: "aws/ec2" });

  const deps: ReportGetDeps = {
    ...makeDeps(),
    lookupDefinition: (idOrName: string) => {
      if (idOrName === "my-model") {
        return Promise.resolve({ definition: def, type: modelType });
      }
      return Promise.resolve(null);
    },
    findAllForModel: () => Promise.resolve([reportData]),
    getContent: (
      _type: ModelType,
      _modelId: string,
      dataName: string,
    ) => {
      if (dataName.endsWith("-json")) {
        return Promise.resolve(new TextEncoder().encode("{}"));
      }
      return Promise.resolve(
        new TextEncoder().encode("# Scoped Report"),
      );
    },
    lookupDefinitionById: (_type: ModelType, id: string) => {
      if (id === def.id) return Promise.resolve(def);
      return Promise.resolve(null);
    },
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    reportGet(ctx, deps, { reportName: "cost-report", model: "my-model" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.modelName, "my-model");
    assertEquals(last.data.markdown, "# Scoped Report");
  }
});

function makeVariantReportData(
  name: string,
  reportName: string,
  scope: string,
  varySuffix: string,
): Data {
  return Data.create({
    name,
    contentType: "text/markdown",
    lifetime: "30d",
    garbageCollection: 5,
    tags: { type: "report", reportName, reportScope: scope, varySuffix },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    createdAt: new Date("2026-01-15T10:00:00Z"),
  });
}

Deno.test("reportGet - --variant filters to matching varySuffix", async () => {
  const modelType = ModelType.create("aws/ec2");
  const report1 = makeVariantReportData(
    "report-scan-10.0.0.1",
    "scan-report",
    "method",
    "10.0.0.1",
  );
  const report2 = makeVariantReportData(
    "report-scan-10.0.0.2",
    "scan-report",
    "method",
    "10.0.0.2",
  );

  const deps: ReportGetDeps = {
    ...makeDeps(),
    findAllGlobal: () =>
      Promise.resolve([
        { data: report1, modelType, modelId: "test-id" },
        { data: report2, modelType, modelId: "test-id" },
      ]),
    lookupDefinitionById: () => Promise.resolve(null),
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    reportGet(ctx, deps, {
      reportName: "scan-report",
      variant: "10.0.0.1",
    }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.reportName, "scan-report");
    assertEquals(last.data.varySuffix, "10.0.0.1");
  }
});

Deno.test("reportGet - ambiguity error suggests --variant for multiple variants", async () => {
  const modelType = ModelType.create("aws/ec2");
  const report1 = makeVariantReportData(
    "report-scan-10.0.0.1",
    "scan-report",
    "method",
    "10.0.0.1",
  );
  const report2 = makeVariantReportData(
    "report-scan-10.0.0.2",
    "scan-report",
    "method",
    "10.0.0.2",
  );

  const deps: ReportGetDeps = {
    ...makeDeps(),
    findAllGlobal: () =>
      Promise.resolve([
        { data: report1, modelType, modelId: "test-id" },
        { data: report2, modelType, modelId: "test-id" },
      ]),
    lookupDefinitionById: () => Promise.resolve(null),
  };

  const ctx = createLibSwampContext();
  const events = await collect(
    reportGet(ctx, deps, { reportName: "scan-report" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "validation_failed");
    assertStringIncludes(last.error.message, "--variant");
    assertStringIncludes(last.error.message, "10.0.0.1");
    assertStringIncludes(last.error.message, "10.0.0.2");
  }
});

Deno.test("reportGet - populates varySuffix in returned detail", async () => {
  const modelType = ModelType.create("aws/ec2");
  const reportData = makeVariantReportData(
    "report-scan-10.0.0.1",
    "scan-report",
    "method",
    "10.0.0.1",
  );

  const deps = makeDeps([
    { data: reportData, modelType, modelId: "test-id" },
  ]);

  const ctx = createLibSwampContext();
  const events = await collect(
    reportGet(ctx, deps, { reportName: "scan-report" }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.varySuffix, "10.0.0.1");
  }
});
