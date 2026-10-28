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

import { assertEquals, assertRejects } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { join } from "@std/path";
import { findLatestReportData } from "./catalog_report_adapter.ts";
import { type CatalogRow, CatalogStore } from "./catalog_store.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { Data } from "../../domain/data/data.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";

const modelType = ModelType.create("test/model");
const encoder = new TextEncoder();

interface Fixture extends AsyncDisposable {
  dir: string;
  catalog: CatalogStore;
  dataRepo: FileSystemUnifiedDataRepository;
  service: DataQueryService;
}

async function fixture(): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-report-adapter-" });
  const catalog = new CatalogStore(join(dir, "_catalog.db"));
  const dataRepo = new FileSystemUnifiedDataRepository(dir, undefined, catalog);
  const service = new DataQueryService(catalog, dataRepo);
  return {
    dir,
    catalog,
    dataRepo,
    service,
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

function report(name: string, contentType = "text/markdown"): Data {
  return Data.create({
    name,
    contentType,
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "report", reportName: "@test/summary", reportScope: "model" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

function resource(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "test" },
  });
}

async function save(
  repo: UnifiedDataRepository,
  modelId: string,
  data: Data,
): Promise<void> {
  await repo.save(modelType, modelId, data, encoder.encode("# r\n"));
}

/** `repo` with each findByName call counted by data name. */
function counting(repo: UnifiedDataRepository): {
  repo: Pick<UnifiedDataRepository, "namespace" | "findByName">;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    repo: {
      namespace: repo.namespace,
      findByName: (type, modelId, dataName, version) => {
        reads.push(dataName);
        return repo.findByName(type, modelId, dataName, version);
      },
    },
  };
}

/** `run`'s result and the warnings the adapter logged while it ran. */
async function withWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["swamp", "persistence", "catalog-reports"],
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    const result = await run();
    return {
      result,
      warnings: records.map((r) =>
        r.message.map((part) => String(part)).join("")
      ),
    };
  } finally {
    await reset();
  }
}

function catalogRow(overrides: Partial<CatalogRow>): CatalogRow {
  return {
    namespace: "",
    type_normalized: modelType.normalized,
    model_id: "model-a",
    data_name: "report-ghost",
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    is_step_latest: 1,
    model_name: "a",
    spec_name: "report-ghost",
    data_type: "report",
    content_type: "text/markdown",
    lifetime: "infinite",
    garbage_collection: "5",
    lifecycle: "active",
    owner_type: "model-method",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: '{"type":"report"}',
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    ...overrides,
  };
}

Deno.test("findLatestReportData: reads only report markdown metadata, however much other data there is", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-summary"));
  await save(
    f.dataRepo,
    "model-a",
    report("report-summary-json", "application/json"),
  );
  for (let i = 0; i < 20; i++) {
    await save(f.dataRepo, `model-${i % 4}`, resource(`resource-${i}`));
  }
  const { repo, reads } = counting(f.dataRepo);

  const items = await findLatestReportData(f.service, f.catalog, repo);

  assertEquals(items.map((i) => [i.modelId, i.data.name]), [
    ["model-a", "report-summary"],
  ]);
  assertEquals(reads, ["report-summary"]);
});

Deno.test("findLatestReportData: an owner returns that owner's reports only", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  await save(f.dataRepo, "model-b", report("report-b"));

  const items = await findLatestReportData(f.service, f.catalog, f.dataRepo, {
    owner: { type: modelType, modelId: "model-b" },
  });

  assertEquals(items.map((i) => [i.modelId, i.data.name]), [
    ["model-b", "report-b"],
  ]);
});

Deno.test("findLatestReportData: returns the latest version of each report", async () => {
  await using f = await fixture();
  for (let i = 0; i < 3; i++) {
    await save(f.dataRepo, "model-a", report("report-a"));
  }

  const items = await findLatestReportData(f.service, f.catalog, f.dataRepo);

  assertEquals(items.map((i) => [i.data.name, i.data.version]), [
    ["report-a", 3],
  ]);
});

Deno.test("findLatestReportData: leaves out another namespace's report rows without reading them", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  f.catalog.upsertNewVersion(
    catalogRow({ namespace: "other", data_name: "report-foreign" }),
  );
  const { repo, reads } = counting(f.dataRepo);

  const items = await findLatestReportData(f.service, f.catalog, repo);

  assertEquals(items.map((i) => i.data.name), ["report-a"]);
  assertEquals(reads, ["report-a"]);
});

Deno.test("findLatestReportData: leaves out a pending (unpublished) report row without reading it", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  // Flagged latest too, so only its pending state can keep it out.
  f.catalog.upsert(
    catalogRow({ data_name: "report-pending", is_latest: 1, is_pending: 1 }),
  );
  const { repo, reads } = counting(f.dataRepo);

  const items = await findLatestReportData(f.service, f.catalog, repo);

  assertEquals(items.map((i) => i.data.name), ["report-a"]);
  assertEquals(reads, ["report-a"]);
});

Deno.test("findLatestReportData: skips a catalog row whose item is gone", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  f.catalog.upsertNewVersion(catalogRow({ data_name: "report-ghost" }));

  const { result: items, warnings } = await withWarnings(() =>
    findLatestReportData(f.service, f.catalog, f.dataRepo)
  );

  assertEquals(items.map((i) => i.data.name), ["report-a"]);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("report-ghost"), true);
  assertEquals(warnings[0].includes("of a (test/model)"), true);
  assertEquals(
    warnings[0].includes("run swamp doctor datastores to check"),
    true,
  );
  assertEquals(warnings[0].includes("--repair"), false);
});

Deno.test("findLatestReportData: a renamed report is returned once, under its new name", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-old"));
  await f.dataRepo.rename(modelType, "model-a", "report-old", "report-new");
  // A rename drops the old name's rows; a catalog that missed that still
  // names the old name at its rename marker's version.
  f.catalog.upsertNewVersion(
    catalogRow({ data_name: "report-old", version: 2 }),
  );

  const { result: items, warnings } = await withWarnings(() =>
    findLatestReportData(f.service, f.catalog, f.dataRepo)
  );

  assertEquals(items.map((i) => i.data.name), ["report-new"]);
  assertEquals(items.some((i) => i.data.isRenamed), false);
  assertEquals(warnings, []);
});

Deno.test("findLatestReportData: skips a report whose metadata is empty or whose read fails, and returns the rest", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-ok"));
  await save(f.dataRepo, "model-a", report("report-empty"));
  await save(f.dataRepo, "model-a", report("report-throws"));
  await Deno.writeTextFile(
    join(
      f.dataRepo.getDataNameDir(modelType, "model-a", "report-empty"),
      "1",
      "metadata.yaml",
    ),
    "",
  );
  const repo: Pick<UnifiedDataRepository, "namespace" | "findByName"> = {
    namespace: f.dataRepo.namespace,
    findByName: (type, modelId, dataName, version) =>
      dataName === "report-throws"
        ? Promise.reject(new Error("permission denied"))
        : f.dataRepo.findByName(type, modelId, dataName, version),
  };

  const { result: items, warnings } = await withWarnings(() =>
    findLatestReportData(f.service, f.catalog, repo)
  );

  assertEquals(items.map((i) => i.data.name), ["report-ok"]);
  assertEquals(
    warnings.map((w) =>
      ["report-empty", "report-throws"].find((name) => w.includes(name))
    ).sort(),
    ["report-empty", "report-throws"],
  );
  assertEquals(
    warnings.some((w) => w.includes("permission denied")),
    true,
  );
});

Deno.test("findLatestReportData: an aborted signal rejects with its reason and reads nothing", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  const { repo, reads } = counting(f.dataRepo);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);

  const error = await assertRejects(() =>
    findLatestReportData(f.service, f.catalog, repo, {
      signal: controller.signal,
    })
  );

  assertEquals(error, reason);
  assertEquals(reads, []);
});

Deno.test("findLatestReportData: an abort that lands while a read fails is raised, not skipped", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const repo: Pick<UnifiedDataRepository, "namespace" | "findByName"> = {
    namespace: f.dataRepo.namespace,
    findByName: () => {
      controller.abort(reason);
      return Promise.reject(new Error("read failed"));
    },
  };

  const error = await assertRejects(() =>
    findLatestReportData(f.service, f.catalog, repo, {
      signal: controller.signal,
    })
  );

  assertEquals(error, reason);
});

Deno.test("findLatestReportData: an unpopulated catalog is backfilled before candidates are chosen", async () => {
  await using f = await fixture();
  await save(f.dataRepo, "model-a", report("report-a"));
  await save(f.dataRepo, "model-a", resource("resource-a"));
  f.catalog.invalidate();

  const items = await findLatestReportData(f.service, f.catalog, f.dataRepo);

  assertEquals(items.map((i) => i.data.name), ["report-a"]);
});
