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
    findDataByVersion: () => Promise.resolve(null),
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

function makeReportVersion(
  version: number,
  opts: { name?: string; varySuffix?: string; createdAt?: Date } = {},
): Data {
  return Data.create({
    name: opts.name ?? "report-cost",
    version,
    contentType: "text/markdown",
    lifetime: "30d",
    garbageCollection: 5,
    tags: {
      type: "report",
      reportName: "cost-report",
      reportScope: "model",
      ...(opts.varySuffix ? { varySuffix: opts.varySuffix } : {}),
    },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
    createdAt: opts.createdAt ?? new Date(`2026-01-1${version}T10:00:00Z`),
  });
}

interface VersionLookup {
  dataName: string;
  version: number;
}

/**
 * Deps over one report data item stored at versions 1..3, where the
 * latest-only finders return v3 and findDataByVersion serves any stored
 * version. Records every version lookup and content read.
 */
function makeVersionedDeps(): {
  deps: ReportGetDeps;
  lookups: VersionLookup[];
  contentReads: Array<{ dataName: string; version?: number }>;
} {
  const modelType = ModelType.create("aws/ec2");
  const def = Definition.create({ name: "my-model", type: "aws/ec2" });
  const versions = [1, 2, 3].map((v) => makeReportVersion(v));
  const latest = versions[2];
  const lookups: VersionLookup[] = [];
  const contentReads: Array<{ dataName: string; version?: number }> = [];

  const deps: ReportGetDeps = {
    findAllGlobal: () =>
      Promise.resolve([{ data: latest, modelType, modelId: def.id }]),
    findAllForModel: () => Promise.resolve([latest]),
    findDataByVersion: (_type, _modelId, dataName, version) => {
      lookups.push({ dataName, version });
      return Promise.resolve(
        versions.find((d) => d.name === dataName && d.version === version) ??
          null,
      );
    },
    getContent: (_type, _modelId, dataName, version) => {
      contentReads.push({ dataName, version });
      const body = dataName.endsWith("-json")
        ? JSON.stringify({ v: version })
        : `# v${version}`;
      return Promise.resolve(new TextEncoder().encode(body));
    },
    lookupDefinition: (idOrName) =>
      Promise.resolve(
        idOrName === "my-model" ? { definition: def, type: modelType } : null,
      ),
    lookupDefinitionById: () => Promise.resolve(def),
    findWorkflowByName: (name) =>
      Promise.resolve(
        name === "my-workflow" ? { id: "wf-id", name: "my-workflow" } : null,
      ),
    findWorkflowById: () =>
      Promise.resolve({ id: "wf-id", name: "my-workflow" }),
  };
  return { deps, lookups, contentReads };
}

for (
  const [label, scope] of [
    ["model", { model: "my-model" }],
    ["workflow", { workflow: "my-workflow" }],
    ["global", {}],
  ] as const
) {
  Deno.test(`reportGet: --version returns an older version on the ${label} path`, async () => {
    const { deps, lookups, contentReads } = makeVersionedDeps();

    const events = await collect(
      reportGet(createLibSwampContext(), deps, {
        reportName: "cost-report",
        version: 1,
        ...scope,
      }),
    );
    const last = events[events.length - 1];

    assertEquals(last.kind, "completed");
    if (last.kind === "completed") {
      assertEquals(last.data.version, 1);
      assertEquals(last.data.markdown, "# v1");
      assertEquals(last.data.json, { v: 1 });
    }
    assertEquals(lookups, [{ dataName: "report-cost", version: 1 }]);
    assertEquals(contentReads, [
      { dataName: "report-cost", version: 1 },
      { dataName: "report-cost-json", version: 1 },
    ]);
  });
}

Deno.test("reportGet: --version errors when the version does not exist", async () => {
  const { deps } = makeVersionedDeps();

  const events = await collect(
    reportGet(createLibSwampContext(), deps, {
      reportName: "cost-report",
      model: "my-model",
      version: 99,
    }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "error");
  if (last.kind === "error") {
    assertEquals(last.error.code, "not_found");
    assertStringIncludes(last.error.message, "version 99");
  }
});

Deno.test("reportGet: without --version returns the latest without a version lookup", async () => {
  const { deps, lookups } = makeVersionedDeps();

  const events = await collect(
    reportGet(createLibSwampContext(), deps, {
      reportName: "cost-report",
      model: "my-model",
    }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.version, 3);
    assertEquals(last.data.markdown, "# v3");
  }
  assertEquals(lookups, []);
});

Deno.test("reportGet: --version looks up the newest candidate's data name", async () => {
  const modelType = ModelType.create("aws/ec2");
  const untagged = makeReportVersion(4, {
    createdAt: new Date("2026-01-10T10:00:00Z"),
  });
  const tagged = makeReportVersion(4, {
    name: "report-cost-eu",
    varySuffix: "eu",
    createdAt: new Date("2026-01-20T10:00:00Z"),
  });
  const lookups: VersionLookup[] = [];

  const deps: ReportGetDeps = {
    ...makeDeps([
      { data: untagged, modelType, modelId: "test-id" },
      { data: tagged, modelType, modelId: "test-id" },
    ]),
    findDataByVersion: (_type, _modelId, dataName, version) => {
      lookups.push({ dataName, version });
      return Promise.resolve(
        makeReportVersion(version, { name: dataName, varySuffix: "eu" }),
      );
    },
  };

  const events = await collect(
    reportGet(createLibSwampContext(), deps, {
      reportName: "cost-report",
      version: 2,
    }),
  );
  const last = events[events.length - 1];

  assertEquals(last.kind, "completed");
  if (last.kind === "completed") {
    assertEquals(last.data.dataName, "report-cost-eu");
    assertEquals(last.data.version, 2);
  }
  assertEquals(lookups, [{ dataName: "report-cost-eu", version: 2 }]);
});
