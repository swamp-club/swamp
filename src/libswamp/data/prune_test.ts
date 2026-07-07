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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  dataPrune,
  type DataPruneDeps,
  type DataPruneEvent,
  dataPrunePreview,
} from "./prune.ts";
import type { OrphanReclamationResult } from "../../domain/data/data_lifecycle_service.ts";

function emptyResult(
  overrides: Partial<OrphanReclamationResult> = {},
): OrphanReclamationResult {
  return {
    modelsReclaimed: 0,
    dataEntriesReclaimed: 0,
    versionsDeleted: 0,
    bytesReclaimed: 0,
    dryRun: false,
    reclaimedModels: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DataPruneDeps> = {}): DataPruneDeps {
  return {
    findOrphanedData: () => Promise.resolve([]),
    deleteOrphanedData: () => Promise.resolve(emptyResult()),
    ...overrides,
  };
}

Deno.test("dataPrunePreview: returns empty preview when no orphaned data", async () => {
  const preview = await dataPrunePreview(createLibSwampContext(), makeDeps());

  assertEquals(preview.items.length, 0);
});

Deno.test("dataPrunePreview: maps orphaned models into preview items", async () => {
  const deps = makeDeps({
    findOrphanedData: () =>
      Promise.resolve([
        {
          type: { toDirectoryPath: () => "command/shell" },
          modelId: "m1",
          modelName: "hello",
          dataNames: ["result", "log"],
          versionCount: 4,
          bytesReclaimed: 2048,
        },
      ] as unknown as import("../../domain/data/data_lifecycle_service.ts").OrphanedDataInfo[]),
  });

  const preview = await dataPrunePreview(createLibSwampContext(), deps);

  assertEquals(preview.items.length, 1);
  assertEquals(preview.items[0].type, "command/shell");
  assertEquals(preview.items[0].modelId, "m1");
  assertEquals(preview.items[0].modelName, "hello");
  assertEquals(preview.items[0].dataNames, ["result", "log"]);
  assertEquals(preview.items[0].versionCount, 4);
  assertEquals(preview.items[0].bytesReclaimed, 2048);
});

Deno.test("dataPrune: yields completed with reclamation results", async () => {
  const deps = makeDeps({
    deleteOrphanedData: () =>
      Promise.resolve(emptyResult({
        modelsReclaimed: 2,
        dataEntriesReclaimed: 5,
        versionsDeleted: 9,
        bytesReclaimed: 4096,
      })),
  });

  const events = await collect<DataPruneEvent>(
    dataPrune(createLibSwampContext(), deps, { dryRun: false }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "collecting");
  const completed = events[1] as Extract<
    DataPruneEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.modelsReclaimed, 2);
  assertEquals(completed.data.dataEntriesReclaimed, 5);
  assertEquals(completed.data.versionsDeleted, 9);
  assertEquals(completed.data.bytesReclaimed, 4096);
  assertEquals(completed.data.dryRun, false);
});

Deno.test("dataPrune: calls compactCatalog and includes WAL stats", async () => {
  let compactCalled = false;
  const deps = makeDeps({
    compactCatalog: () => {
      compactCalled = true;
      return { walPagesTotal: 12, walPagesCheckpointed: 12 };
    },
  });

  const events = await collect<DataPruneEvent>(
    dataPrune(createLibSwampContext(), deps, { dryRun: false }),
  );

  assertEquals(compactCalled, true);
  const completed = events.find((e) => e.kind === "completed") as Extract<
    DataPruneEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.walPagesTotal, 12);
  assertEquals(completed.data.walPagesCheckpointed, 12);
});

Deno.test("dataPrune: skips compactCatalog on dry-run", async () => {
  let compactCalled = false;
  const deps = makeDeps({
    compactCatalog: () => {
      compactCalled = true;
      return { walPagesTotal: 12, walPagesCheckpointed: 12 };
    },
  });

  await collect<DataPruneEvent>(
    dataPrune(createLibSwampContext(), deps, { dryRun: true }),
  );

  assertEquals(compactCalled, false);
});

Deno.test("dataPrune: passes dryRun flag through to deleteOrphanedData", async () => {
  let receivedDryRun = false;
  const deps = makeDeps({
    deleteOrphanedData: (opts) => {
      receivedDryRun = opts.dryRun;
      return Promise.resolve(emptyResult({ dryRun: true }));
    },
  });

  await collect<DataPruneEvent>(
    dataPrune(createLibSwampContext(), deps, { dryRun: true }),
  );

  assertEquals(receivedDryRun, true);
});
