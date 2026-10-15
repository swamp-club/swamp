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
import {
  ControlPlaneRetentionWatermarkRepository,
  hourStartOf,
} from "./control_plane_retention_watermark_repository.ts";
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";
import type { RetentionWatermark } from "../../domain/retention/retention_watermark.ts";
import {
  lastPassAt,
  reapedBefore,
} from "../../domain/retention/retention_watermark.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

function watermark(
  overrides: Partial<RetentionWatermark> = {},
): RetentionWatermark {
  return {
    kind: "workflowRuns",
    cutoff: "2026-10-01T00:00:00.000Z",
    retention: "14d",
    lastPassAt: "2026-10-15T10:00:00.000Z",
    complete: true,
    deleted: 3,
    bytesReclaimed: 1024,
    ...overrides,
  };
}

Deno.test("ControlPlaneRetentionWatermarkRepository: put overwrites the one record per kind", async () => {
  await withTempDir(async (dir) => {
    const repo = new ControlPlaneRetentionWatermarkRepository(
      new FileSystemControlPlaneStore(dir),
    );
    assertEquals(await repo.get("workflowRuns"), null);
    await repo.put(watermark());
    await repo.put(watermark({ deleted: 9 }));
    await repo.put(watermark({ kind: "outputs" }));
    assertEquals((await repo.get("workflowRuns"))?.deleted, 9);
    assertEquals(
      (await repo.getAll()).map((w) => w.kind),
      ["workflowRuns", "outputs"],
    );
  });
});

Deno.test("ControlPlaneRetentionWatermarkRepository: an unreadable record reads as absent", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);
    await store.put(
      "retention/watermarks/data",
      new TextEncoder().encode("{not json"),
    );
    const repo = new ControlPlaneRetentionWatermarkRepository(store);
    assertEquals(await repo.get("data"), null);
  });
});

Deno.test("ControlPlaneRetentionWatermarkRepository.claimHourlyPass: one claim per hour wins", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);
    const a = new ControlPlaneRetentionWatermarkRepository(store);
    const b = new ControlPlaneRetentionWatermarkRepository(store);
    const hour = hourStartOf(new Date("2026-10-15T10:42:00.000Z"));
    const results = await Promise.all([
      a.claimHourlyPass(hour, "a"),
      b.claimHourlyPass(hour, "b"),
    ]);
    assertEquals(results.filter(Boolean).length, 1);
    const next = new Date(hour.getTime() + 3_600_000);
    assertEquals(await a.claimHourlyPass(next, "a"), true);
  });
});

Deno.test("ControlPlaneRetentionWatermarkRepository.claimHourlyPass: claims older than a day are removed", async () => {
  await withTempDir(async (dir) => {
    const store = new FileSystemControlPlaneStore(dir);
    const repo = new ControlPlaneRetentionWatermarkRepository(store);
    const first = hourStartOf(new Date("2026-10-13T10:00:00.000Z"));
    await repo.claimHourlyPass(first, "a");
    const later = new Date(first.getTime() + 2 * 86_400_000);
    await repo.claimHourlyPass(later, "a");
    assertEquals(await store.list("retention/claims"), [
      `retention/claims/${later.getTime()}`,
    ]);
  });
});

Deno.test("hourStartOf: truncates to the UTC hour", () => {
  assertEquals(
    hourStartOf(new Date("2026-10-15T10:42:13.500Z")).toISOString(),
    "2026-10-15T10:00:00.000Z",
  );
});

Deno.test("lastPassAt: the newest pass across kinds", () => {
  assertEquals(lastPassAt([]), null);
  assertEquals(
    lastPassAt([
      watermark({ lastPassAt: "2026-10-15T09:00:00.000Z" }),
      watermark({ kind: "data", lastPassAt: "2026-10-15T11:00:00.000Z" }),
    ])?.toISOString(),
    "2026-10-15T11:00:00.000Z",
  );
});

Deno.test("reapedBefore: the cutoff of the kind's watermark", () => {
  const all = [watermark()];
  assertEquals(
    reapedBefore(all, "workflowRuns")?.toISOString(),
    "2026-10-01T00:00:00.000Z",
  );
  assertEquals(reapedBefore(all, "data"), null);
});
