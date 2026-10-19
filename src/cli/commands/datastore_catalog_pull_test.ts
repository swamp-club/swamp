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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  exportRowsToCatalogRows,
  storeForeignCatalogEntries,
} from "./datastore_catalog_pull.ts";
import type { CatalogExportRow } from "../../domain/datastore/datastore_sync_service.ts";
import {
  type CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { restoreNamespace } from "../../domain/data/namespace.ts";

function makeExportRow(
  overrides: Partial<CatalogExportRow> = {},
): CatalogExportRow {
  return {
    namespace: "infra",
    type_normalized: "test-model",
    model_id: "model-001",
    data_name: "item-b",
    id: crypto.randomUUID(),
    version: 1,
    is_latest: 1,
    model_name: "c1",
    spec_name: "item",
    data_type: "resource",
    content_type: "application/json",
    lifetime: "infinite",
    owner_type: "model-method",
    streaming: 0,
    size: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    tags: "{}",
    owner_ref: "",
    workflow_run_id: "",
    workflow_name: "",
    job_name: "",
    step_name: "",
    source: "",
    ...overrides,
  };
}

function flags(
  rows: { version: number; is_latest: number; is_step_latest: number }[],
): string[] {
  return rows.map((r) => `${r.version}:${r.is_latest}:${r.is_step_latest}`);
}

Deno.test("exportRowsToCatalogRows: normalises a legacy export with one latest per step", () => {
  // Written before swamp-club#2520: no is_step_latest, and two workflow
  // steps' versions of one data name both flagged is_latest.
  const rows = exportRowsToCatalogRows([
    makeExportRow({ version: 1, step_name: "s1" }),
    makeExportRow({ version: 2, step_name: "s2" }),
  ]);
  assertEquals(flags(rows), ["1:0:1", "2:1:1"]);
});

Deno.test("exportRowsToCatalogRows: keeps step latests from a current export", () => {
  const rows = exportRowsToCatalogRows([
    makeExportRow({
      version: 1,
      step_name: "s1",
      is_latest: 0,
      is_step_latest: 1,
    }),
    makeExportRow({
      version: 2,
      step_name: "s2",
      is_latest: 1,
      is_step_latest: 1,
    }),
  ]);
  assertEquals(flags(rows), ["1:0:1", "2:1:1"]);
});

Deno.test("exportRowsToCatalogRows: leaves rows the export did not flag unflagged", () => {
  const rows = exportRowsToCatalogRows([
    makeExportRow({ version: 1, is_latest: 1 }),
    makeExportRow({ version: 2, is_latest: 0, is_step_latest: 0 }),
  ]);
  assertEquals(flags(rows), ["1:1:1", "2:0:0"]);
});

Deno.test("exportRowsToCatalogRows: carries garbage_collection from the export", () => {
  const [row] = exportRowsToCatalogRows([
    makeExportRow({ garbage_collection: "7d" }),
  ]);
  assertEquals(row.garbage_collection, "7d");
});

Deno.test("exportRowsToCatalogRows: an export without garbage_collection reads as unknown", () => {
  const [row] = exportRowsToCatalogRows([makeExportRow()]);
  assertEquals(row.garbage_collection, "");
});

async function withCatalogStore(
  fn: (store: CatalogStore) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-catalog-pull-" });
  const store = new CatalogStore(join(dir, "_catalog.db"));
  try {
    fn(store);
  } finally {
    store.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** The reader's own row, as the reader's own writes stamp it. */
function ownRow(): CatalogRow {
  return {
    ...exportRowsToCatalogRows([
      makeExportRow({ namespace: "team-a", tags: '{"owner":"a"}' }),
    ])[0],
  };
}

const TEAM_B = restoreNamespace("team-b");

Deno.test("storeForeignCatalogEntries: an export row claiming the reader's namespace leaves the reader's own row unchanged", async () => {
  await withCatalogStore((store) => {
    const own = ownRow();
    store.bulkUpsert([own]);

    const result = storeForeignCatalogEntries(
      [{
        namespace: "team-b",
        rows: [
          makeExportRow({ namespace: "team-b", data_name: "honest" }),
          // Same coordinates as the reader's own row, with a forged
          // sensitive-fields tag, spec name and a newer latest version.
          makeExportRow({
            namespace: "team-a",
            tags: '{"_swamp.sensitiveFields":"[\\"token\\"]"}',
            spec_name: "forged",
            version: 1,
          }),
          makeExportRow({
            namespace: "team-a",
            version: 2,
            is_latest: 1,
          }),
        ],
      }],
      [TEAM_B],
      store,
    );

    assertEquals(result, {
      stored: [{ namespace: TEAM_B, stored: 1, rejected: 2 }],
      unrequested: [],
      missing: [],
    });
    const byNamespace = [...store.iterate()].map((r) => [
      r.namespace,
      r.data_name,
      r.version,
      r.tags,
      r.spec_name,
      r.is_latest,
    ]);
    assertEquals(byNamespace, [
      ["team-a", own.data_name, 1, own.tags, own.spec_name, 1],
      ["team-b", "honest", 1, "{}", "item", 1],
    ]);
  });
});

Deno.test("storeForeignCatalogEntries: ignores an export for a namespace that was not requested, the reader's own included", async () => {
  await withCatalogStore((store) => {
    const own = ownRow();
    store.bulkUpsert([own]);

    const result = storeForeignCatalogEntries(
      [
        {
          namespace: "team-a",
          rows: [makeExportRow({ namespace: "team-a", spec_name: "forged" })],
        },
        { namespace: "team-c", rows: [makeExportRow({ namespace: "team-c" })] },
      ],
      [TEAM_B],
      store,
    );

    assertEquals(result, {
      stored: [],
      unrequested: ["team-a", "team-c"],
      missing: [TEAM_B],
    });
    assertEquals([...store.iterate()].map((r) => r.spec_name), [
      own.spec_name,
    ]);
    assertEquals(store.foreignSyncedAt("team-a"), null);
  });
});

Deno.test("storeForeignCatalogEntries: reports requested namespaces without an export as missing", async () => {
  await withCatalogStore((store) => {
    const security = restoreNamespace("security");
    const result = storeForeignCatalogEntries(
      [{ namespace: "team-b", rows: [makeExportRow({ namespace: "team-b" })] }],
      [TEAM_B, security],
      store,
    );
    assertEquals(result.stored, [{
      namespace: TEAM_B,
      stored: 1,
      rejected: 0,
    }]);
    assertEquals(result.missing, [security]);
  });
});
