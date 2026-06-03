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
  dataGc,
  type DataGcDeps,
  type DataGcEvent,
  dataGcPreview,
} from "./gc.ts";

function makeDeps(overrides: Partial<DataGcDeps> = {}): DataGcDeps {
  return {
    findExpiredData: () => Promise.resolve([]),
    previewVersionGarbage: () => Promise.resolve([]),
    deleteExpiredData: () =>
      Promise.resolve({
        dataEntriesExpired: 0,
        versionsDeleted: 0,
        bytesReclaimed: 0,
        dryRun: false,
        expiredEntries: [],
      }),
    ...overrides,
  };
}

Deno.test("dataGcPreview: returns empty preview when no expired data", async () => {
  const deps = makeDeps();

  const preview = await dataGcPreview(createLibSwampContext(), deps);

  assertEquals(preview.items.length, 0);
  assertEquals(preview.versionGcItems.length, 0);
});

Deno.test("dataGcPreview: aggregates expired and version-gc items", async () => {
  const deps = makeDeps({
    findExpiredData: () =>
      Promise.resolve([
        {
          type: { toDirectoryPath: () => "aws/s3-bucket" },
          modelId: "m1",
          dataName: "data1",
          reason: "duration-expired",
        },
      ] as unknown as import("../../domain/data/data_lifecycle_service.ts").ExpiredDataInfo[]),
    previewVersionGarbage: () =>
      Promise.resolve([
        {
          type: { toDirectoryPath: () => "command/shell" },
          modelId: "m2",
          versionsWouldBeRemoved: 5,
          bytesWouldBeReclaimed: 1024,
        },
      ] as unknown as import("../../domain/data/data_lifecycle_service.ts").VersionGcPreviewInfo[]),
  });

  const preview = await dataGcPreview(createLibSwampContext(), deps);

  assertEquals(preview.items.length, 1);
  assertEquals(preview.items[0].type, "aws/s3-bucket");
  assertEquals(preview.versionGcItems.length, 1);
  assertEquals(preview.versionGcItems[0].type, "command/shell");
  assertEquals(preview.versionGcItems[0].versionsWouldBeRemoved, 5);
  assertEquals(preview.versionGcItems[0].bytesWouldBeReclaimed, 1024);
});

Deno.test("dataGcPreview: returns preview items for expired data", async () => {
  const deps = makeDeps({
    findExpiredData: () =>
      Promise.resolve([
        {
          type: { toDirectoryPath: () => "aws/s3-bucket" },
          modelId: "m1",
          dataName: "data1",
          reason: "expired",
        },
      ] as unknown as import("../../domain/data/data_lifecycle_service.ts").ExpiredDataInfo[]),
  });

  const preview = await dataGcPreview(createLibSwampContext(), deps);

  assertEquals(preview.items.length, 1);
  assertEquals(preview.items[0].type, "aws/s3-bucket");
  assertEquals(preview.items[0].dataName, "data1");
});

Deno.test("dataGc: yields completed with gc results", async () => {
  const deps = makeDeps({
    deleteExpiredData: () =>
      Promise.resolve({
        dataEntriesExpired: 3,
        versionsDeleted: 5,
        bytesReclaimed: 1024,
        dryRun: false,
        expiredEntries: [],
      }),
  });

  const events = await collect<DataGcEvent>(
    dataGc(createLibSwampContext(), deps, { dryRun: false }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "collecting");
  const completed = events[1] as Extract<
    DataGcEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.dataEntriesExpired, 3);
  assertEquals(completed.data.versionsDeleted, 5);
  assertEquals(completed.data.dryRun, false);
});

Deno.test("dataGc: calls compactCatalog and includes WAL stats in completed event", async () => {
  let compactCalled = false;
  const deps = makeDeps({
    compactCatalog: () => {
      compactCalled = true;
      return { walPagesTotal: 20, walPagesCheckpointed: 20 };
    },
  });

  const events = await collect<DataGcEvent>(
    dataGc(createLibSwampContext(), deps, { dryRun: false }),
  );

  assertEquals(compactCalled, true);
  const completed = events.find((e) => e.kind === "completed") as Extract<
    DataGcEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.walPagesTotal, 20);
  assertEquals(completed.data.walPagesCheckpointed, 20);
});

Deno.test("dataGc: skips compactCatalog on dry-run", async () => {
  let compactCalled = false;
  const deps = makeDeps({
    compactCatalog: () => {
      compactCalled = true;
      return { walPagesTotal: 20, walPagesCheckpointed: 20 };
    },
  });

  await collect<DataGcEvent>(
    dataGc(createLibSwampContext(), deps, { dryRun: true }),
  );

  assertEquals(compactCalled, false);
});

Deno.test("dataGc: WAL stats default to zero when compactCatalog is not provided", async () => {
  const deps = makeDeps();

  const events = await collect<DataGcEvent>(
    dataGc(createLibSwampContext(), deps, { dryRun: false }),
  );

  const completed = events.find((e) => e.kind === "completed") as Extract<
    DataGcEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.walPagesTotal, 0);
  assertEquals(completed.data.walPagesCheckpointed, 0);
});

Deno.test("dataGc: passes dryRun flag through", async () => {
  let receivedDryRun = false;
  const deps = makeDeps({
    deleteExpiredData: (opts) => {
      receivedDryRun = opts.dryRun;
      return Promise.resolve({
        dataEntriesExpired: 0,
        versionsDeleted: 0,
        bytesReclaimed: 0,
        dryRun: true,
        expiredEntries: [],
      });
    },
  });

  await collect<DataGcEvent>(
    dataGc(createLibSwampContext(), deps, { dryRun: true }),
  );

  assertEquals(receivedDryRun, true);
});
