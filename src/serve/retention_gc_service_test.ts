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
import { RetentionGcService } from "./retention_gc_service.ts";
import { GcMutex } from "./gc_mutex.ts";
import {
  type RetentionConfig,
  RetentionPolicy,
} from "../domain/retention/retention_policy.ts";
import type { RetentionPassResult } from "../libswamp/retention/pass.ts";
import { ControlPlaneRetentionWatermarkRepository } from "../infrastructure/persistence/control_plane_retention_watermark_repository.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";

const NOW = new Date("2026-10-15T10:30:00.000Z");

function passResult(): RetentionPassResult {
  return { startedAt: NOW.toISOString(), kinds: [], complete: true };
}

function service(
  config: RetentionConfig,
  options: {
    mutex?: GcMutex;
    passes?: number[];
    onPass?: (r: RetentionPassResult) => void;
    watermarks?: ControlPlaneRetentionWatermarkRepository;
    instanceId?: string;
  } = {},
): RetentionGcService {
  const passes = options.passes ?? [];
  return new RetentionGcService({
    intervalMs: 3_600_000,
    instanceId: options.instanceId ?? "serve-a",
    mutex: options.mutex ?? new GcMutex(),
    watermarks: options.watermarks,
    readPolicy: () => Promise.resolve(RetentionPolicy.fromConfig(config)),
    runPass: () => {
      passes.push(passes.length);
      return Promise.resolve(passResult());
    },
    onPass: options.onPass,
    now: () => NOW,
  });
}

Deno.test("RetentionGcService.runOnce: runs no pass unless automatic is on", async () => {
  const passes: number[] = [];
  assertEquals(
    await service({ retention: "30d" }, { passes }).runOnce(),
    undefined,
  );
  assertEquals(
    await service({ automatic: true }, { passes }).runOnce(),
    undefined,
  );
  assertEquals(passes, []);
});

Deno.test("RetentionGcService.runOnce: runs a pass and reports it", async () => {
  const passes: number[] = [];
  const seen: RetentionPassResult[] = [];
  const result = await service(
    { automatic: true, retention: "30d" },
    { passes, onPass: (r) => seen.push(r) },
  ).runOnce();
  assertEquals(result?.complete, true);
  assertEquals(passes.length, 1);
  assertEquals(seen.length, 1);
});

Deno.test("RetentionGcService.runOnce: skips while a manual gc holds the mutex", async () => {
  const mutex = new GcMutex();
  const passes: number[] = [];
  let release!: () => void;
  const manual = mutex.run(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const result = await service(
    { automatic: true, retention: "30d" },
    { mutex, passes },
  ).runOnce();
  assertEquals(result, undefined);
  assertEquals(passes, []);
  release();
  await manual;
});

Deno.test("RetentionGcService.runOnce: one of two serves on a datastore runs each hour", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new FileSystemControlPlaneStore(dir);
    const passes: number[] = [];
    const config = { automatic: true, retention: "30d" };
    const a = service(config, {
      passes,
      instanceId: "a",
      watermarks: new ControlPlaneRetentionWatermarkRepository(store),
    });
    const b = service(config, {
      passes,
      instanceId: "b",
      watermarks: new ControlPlaneRetentionWatermarkRepository(store),
    });
    await Promise.all([a.runOnce(), b.runOnce()]);
    assertEquals(passes.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("GcMutex.run: collections run one at a time, in order", async () => {
  const mutex = new GcMutex();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = mutex.run(async () => {
    order.push("first:start");
    await new Promise<void>((resolve) => (releaseFirst = resolve));
    order.push("first:end");
  });
  const second = mutex.run(() => {
    order.push("second");
    return Promise.resolve();
  });
  assertEquals(mutex.held, true);
  assertEquals(await mutex.tryRun(() => Promise.resolve(1)), undefined);
  releaseFirst();
  await Promise.all([first, second]);
  assertEquals(order, ["first:start", "first:end", "second"]);
  assertEquals(mutex.held, false);
  assertEquals(await mutex.tryRun(() => Promise.resolve(1)), 1);
});

Deno.test("RetentionGcService.runOnce: a busy mutex leaves the hour unclaimed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = new FileSystemControlPlaneStore(dir);
    const mutex = new GcMutex();
    const passes: number[] = [];
    const config = { automatic: true, retention: "30d" };
    let release!: () => void;
    const manual = mutex.run(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const busy = service(config, {
      mutex,
      passes,
      instanceId: "busy",
      watermarks: new ControlPlaneRetentionWatermarkRepository(store),
    });
    assertEquals(await busy.runOnce(), undefined);
    release();
    await manual;
    // Another serve can still take this hour's pass.
    const other = service(config, {
      passes,
      instanceId: "other",
      watermarks: new ControlPlaneRetentionWatermarkRepository(store),
    });
    assertEquals((await other.runOnce())?.complete, true);
    assertEquals(passes.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});
