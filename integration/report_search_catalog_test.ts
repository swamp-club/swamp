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
 * Report search and get choose their candidates from the data catalog by tag
 * and read only report metadata (swamp-club#4075). These tests wire the
 * catalog adapter and the full-walk dependency it replaced to the same real
 * repository, and require the same results for every filter.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { findLatestReportData } from "../src/infrastructure/persistence/catalog_report_adapter.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type { ReportDefinition } from "../src/domain/reports/report.ts";
import {
  reportSearch,
  type ReportSearchDeps,
  type ReportSearchInput,
} from "../src/libswamp/reports/search.ts";
import { reportGet, type ReportGetDeps } from "../src/libswamp/reports/get.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";

const modelType = ModelType.create("test/model");
const workflowType = ModelType.create("workflow");
const encoder = new TextEncoder();

const alpha = Definition.create({ name: "alpha", type: "test/model" });
const beta = Definition.create({ name: "beta", type: "test/model" });
const gamma = Definition.create({ name: "gamma", type: "test/model" });
const definitions = [alpha, beta, gamma];
const workflow = { id: crypto.randomUUID(), name: "deploy" };

const reportDefinitions: Record<string, Partial<ReportDefinition>> = {
  "@test/summary": { labels: ["ops"] },
  "@test/cost": { labels: ["finops", "ops"] },
  "@test/wf": { labels: ["finops"] },
  "@test/legacy": { labels: ["ops"] },
};

function reportData(
  name: string,
  reportName: string,
  reportScope: string,
  extraTags: Record<string, string> = {},
  contentType = "text/markdown",
): Data {
  return Data.create({
    name,
    contentType,
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "report", reportName, reportScope, ...extraTags },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

function resourceData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

interface Fixture extends AsyncDisposable {
  catalog: CatalogStore;
  dataRepo: FileSystemUnifiedDataRepository;
  service: DataQueryService;
}

async function openFixture(): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-report-catalog-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  return {
    catalog,
    dataRepo,
    service: new DataQueryService(catalog, dataRepo),
    async [Symbol.asyncDispose]() {
      catalog.close();
      if (Deno.build.os === "windows") {
        // Best-effort: EBUSY can fire when V8 hasn't GC'd native
        // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    },
  };
}

/**
 * Method-, model- and workflow-scoped reports of three types, with variants,
 * a renamed report, a report whose latest version is a deletion marker, the
 * paired JSON artifacts, and non-report data beside each.
 */
async function writeFixture(repo: FileSystemUnifiedDataRepository) {
  const save = (type: ModelType, modelId: string, data: Data) =>
    repo.save(type, modelId, data, encoder.encode("# report\n"));

  for (let v = 0; v < 2; v++) {
    await save(
      modelType,
      alpha.id,
      reportData("report-test-summary", "@test/summary", "method"),
    );
  }
  await save(
    modelType,
    alpha.id,
    reportData(
      "report-test-summary-json",
      "@test/summary",
      "method",
      {},
      "application/json",
    ),
  );
  await save(
    modelType,
    alpha.id,
    reportData("report-old", "@test/legacy", "model"),
  );
  await repo.rename(modelType, alpha.id, "report-old", "report-renamed");

  for (const suffix of ["10.0.0.1", "10.0.0.2"]) {
    await save(
      modelType,
      beta.id,
      reportData(`report-test-cost-${suffix}`, "@test/cost", "model", {
        varySuffix: suffix,
      }),
    );
  }

  const gone = reportData("report-test-gone", "@test/cost", "model");
  await save(modelType, gamma.id, gone);
  await repo.save(
    modelType,
    gamma.id,
    gone.withDeletionMarker({ version: 2 }),
    encoder.encode("{}"),
  );

  await save(
    workflowType,
    workflow.id,
    reportData("report-test-wf", "@test/wf", "workflow"),
  );

  for (
    const [type, id] of [
      [modelType, alpha.id],
      [modelType, beta.id],
      [modelType, gamma.id],
      [workflowType, workflow.id],
    ] as const
  ) {
    for (let i = 0; i < 5; i++) await save(type, id, resourceData(`res-${i}`));
  }
}

function lookups(): Omit<ReportSearchDeps, "findReportData"> {
  return {
    lookupDefinition: (idOrName) => {
      const def = definitions.find((d) =>
        d.name === idOrName || d.id === idOrName
      );
      return Promise.resolve(def ? { definition: def, type: modelType } : null);
    },
    lookupDefinitionById: (_type, id) =>
      Promise.resolve(definitions.find((d) => d.id === id) ?? null),
    findWorkflowByName: (name) =>
      Promise.resolve(name === workflow.name ? workflow : null),
    findWorkflowById: (id) =>
      Promise.resolve(id === workflow.id ? workflow : null),
    getReport: (name) =>
      Promise.resolve(reportDefinitions[name] as ReportDefinition | undefined),
  };
}

/** The dependency the catalog adapter replaced: every data item, walked. */
function fullWalk(
  repo: FileSystemUnifiedDataRepository,
): ReportSearchDeps["findReportData"] {
  return async (scope) => {
    if (!scope) return await repo.findAllGlobal();
    const items = await repo.findAllForModel(scope.type, scope.modelId);
    return items.map((data) => ({
      data,
      modelType: scope.type,
      modelId: scope.modelId,
    }));
  };
}

function catalogBacked(f: Fixture): ReportSearchDeps["findReportData"] {
  return (scope) =>
    findLatestReportData(f.service, f.catalog, f.dataRepo, { owner: scope });
}

async function search(
  findReportData: ReportSearchDeps["findReportData"],
  input: ReportSearchInput,
) {
  const events = await collect(
    reportSearch(createLibSwampContext(), {
      ...lookups(),
      findReportData,
    }, input),
  );
  const last = events[events.length - 1];
  if (last.kind !== "completed") {
    throw new Error(`search ${JSON.stringify(input)} ended with ${last.kind}`);
  }
  return last.data.reports;
}

/**
 * `reports` in owner, data name and version order. The search orders by
 * createdAt alone, so reports stored in the same millisecond tie, and a tie
 * keeps the candidates' order, which differs between the walk (owners by
 * id) and the catalog (insertion). The comparison is of the set found.
 */
function sorted<
  T extends { modelId: string; dataName: string; version: number },
>(
  reports: T[],
): T[] {
  const key = (r: T) => `${r.modelId}\0${r.dataName}\0${r.version}`;
  return [...reports].sort((a, b) => key(a).localeCompare(key(b)));
}

const FILTERS: ReportSearchInput[] = [
  {},
  { scope: "method" },
  { scope: "model" },
  { scope: "workflow" },
  { type: "@test/cost" },
  { labels: ["finops"] },
  { labels: ["ops", "finops"] },
  { query: "10.0.0.2" },
  { model: "alpha" },
  { model: "beta" },
  { model: "gamma" },
  { workflow: "deploy" },
];

Deno.test("report search: the catalog-backed candidates give the full walk's results for every filter", async () => {
  await using f = await openFixture();
  await writeFixture(f.dataRepo);

  for (const input of FILTERS) {
    const expected = await search(fullWalk(f.dataRepo), input);
    const actual = await search(catalogBacked(f), input);
    assertEquals(
      sorted(actual),
      sorted(expected),
      `filter ${JSON.stringify(input)}`,
    );
  }
  // The fixture exercises every case: both owners' kinds, the rename, and a
  // report whose latest version is a deletion marker left out.
  const all = await search(catalogBacked(f), {});
  assertEquals(
    all.map((r) => r.dataName).sort(),
    [
      "report-renamed",
      "report-test-cost-10.0.0.1",
      "report-test-cost-10.0.0.2",
      "report-test-summary",
      "report-test-wf",
    ],
  );
});

Deno.test("report search: a catalog rebuilt from the walk gives the same results", async () => {
  await using f = await openFixture();
  await writeFixture(f.dataRepo);
  const expected = await search(fullWalk(f.dataRepo), {});
  f.catalog.invalidate();

  assertEquals(sorted(await search(catalogBacked(f), {})), sorted(expected));
});

// Each input matches one report, or one owner's variants, which both sources
// list in the same order: search and get order by createdAt alone, which the
// repository stamps at save, so two reports can tie and a tie keeps each
// source's own candidate order.
Deno.test("report get: the catalog-backed candidates find the same report as the full walk", async () => {
  await using f = await openFixture();
  await writeFixture(f.dataRepo);
  const get = async (
    findReportData: ReportGetDeps["findReportData"],
    input: { reportName: string; model?: string; workflow?: string },
  ) => {
    const { getReport: _getReport, ...rest } = lookups();
    const events = await collect(
      reportGet(createLibSwampContext(), {
        ...rest,
        findReportData,
        findDataByVersion: (type, modelId, dataName, version) =>
          f.dataRepo.findByName(type, modelId, dataName, version),
        getContent: (type, modelId, dataName, version) =>
          f.dataRepo.getContent(type, modelId, dataName, version),
      }, input),
    );
    return events[events.length - 1];
  };

  for (
    const input of [
      { reportName: "@test/summary" },
      { reportName: "@test/summary", model: "alpha" },
      { reportName: "@test/wf", workflow: "deploy" },
      { reportName: "@test/cost" },
      { reportName: "@test/legacy" },
    ]
  ) {
    assertEquals(
      await get(catalogBacked(f), input),
      await get(fullWalk(f.dataRepo), input),
      `get ${JSON.stringify(input)}`,
    );
  }
});

Deno.test({
  name:
    "report search: an unreadable non-report data item no longer hides its model's reports",
  // chmod has no effect on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await using f = await openFixture();
    await writeFixture(f.dataRepo);
    const blocked = f.dataRepo.getDataNameDir(modelType, beta.id, "res-0");
    await Deno.chmod(blocked, 0o000);
    try {
      const reports = await search(catalogBacked(f), { model: "beta" });
      assertEquals(reports.map((r) => r.dataName).sort(), [
        "report-test-cost-10.0.0.1",
        "report-test-cost-10.0.0.2",
      ]);
    } finally {
      await Deno.chmod(blocked, 0o755);
    }
  },
});
