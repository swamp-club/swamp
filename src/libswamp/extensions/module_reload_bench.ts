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

// Threshold: ≤ 50 MB heap growth after 100 reloads.

import { join } from "@std/path";
import { assert } from "@std/assert";
import {
  importInSubprocess,
  killSubprocess,
  measureHeap,
  spawnExtensionProcess,
} from "../../infrastructure/testing/subprocess_harness.ts";

const RELOAD_COUNT = 100;
const MAX_HEAP_GROWTH_BYTES = 50 * 1024 * 1024; // 50 MB

Deno.bench(
  "module-reload RAM growth: 100 reloads with distinct fingerprints",
  { group: "module-reload", baseline: true },
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp_bench_reload_" });
    const handle = await spawnExtensionProcess();
    try {
      const bundlePath = join(dir, "bench_model.js");
      await Deno.writeTextFile(
        bundlePath,
        'export const model = { name: "bench", version: "1.0" };\n',
      );

      const heapBefore = await measureHeap(handle);

      for (let i = 0; i < RELOAD_COUNT; i++) {
        await Deno.writeTextFile(
          bundlePath,
          `export const model = { name: "bench", version: "reload-${i}" };\n`,
        );
        await importInSubprocess(handle, bundlePath, `fp-${i}`, "model");
      }

      const heapAfter = await measureHeap(handle);
      const growth = heapAfter.bytes - heapBefore.bytes;
      assert(
        growth <= MAX_HEAP_GROWTH_BYTES,
        `Heap grew ${
          (growth / 1024 / 1024).toFixed(1)
        } MB after ${RELOAD_COUNT} reloads (threshold: ${
          MAX_HEAP_GROWTH_BYTES / 1024 / 1024
        } MB)`,
      );
    } finally {
      await killSubprocess(handle);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);
