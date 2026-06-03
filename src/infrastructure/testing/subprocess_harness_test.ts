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
  importInSubprocess,
  killSubprocess,
  measureHeap,
  spawnExtensionProcess,
} from "./subprocess_harness.ts";

Deno.test("spawnExtensionProcess: starts subprocess and imports a bundle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_sub_test_" });
  try {
    const bundlePath = join(dir, "test_model.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "test", version: "1.0" };\n',
    );

    const handle = await spawnExtensionProcess();
    try {
      const result = await importInSubprocess(
        handle,
        bundlePath,
        "fp1",
        "model",
      );
      assertEquals(result.status, "ok");
      assertEquals(result.hasExport, true);
      assertEquals(result.fingerprint, "fp1");
    } finally {
      await killSubprocess(handle);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importInSubprocess: distinct fingerprints produce distinct modules", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_sub_fp_" });
  try {
    const bundlePath = join(dir, "versioned.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "v1" };\n',
    );

    const handle = await spawnExtensionProcess();
    try {
      const r1 = await importInSubprocess(
        handle,
        bundlePath,
        "fp-aaa",
        "model",
      );
      assertEquals(r1.status, "ok");

      await Deno.writeTextFile(
        bundlePath,
        'export const model = { name: "v2" };\n',
      );

      const r2 = await importInSubprocess(
        handle,
        bundlePath,
        "fp-bbb",
        "model",
      );
      assertEquals(r2.status, "ok");
      assertEquals(r2.fingerprint, "fp-bbb");
    } finally {
      await killSubprocess(handle);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importInSubprocess: same fingerprint returns cached module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_sub_cache_" });
  try {
    const bundlePath = join(dir, "cached.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "original" };\n',
    );

    const handle = await spawnExtensionProcess();
    try {
      const r1 = await importInSubprocess(
        handle,
        bundlePath,
        "same-fp",
        "model",
      );
      assertEquals(r1.status, "ok");

      const r2 = await importInSubprocess(
        handle,
        bundlePath,
        "same-fp",
        "model",
      );
      assertEquals(r2.status, "ok");
      assertEquals(r2.fingerprint, "same-fp");
    } finally {
      await killSubprocess(handle);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("importInSubprocess: empty fingerprint produces bare URL", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_sub_empty_" });
  try {
    const bundlePath = join(dir, "legacy.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "legacy" };\n',
    );

    const handle = await spawnExtensionProcess();
    try {
      const r1 = await importInSubprocess(handle, bundlePath, "", "model");
      assertEquals(r1.status, "ok");
      assertEquals(r1.fingerprint, "");
    } finally {
      await killSubprocess(handle);
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("measureHeap: returns heap size", async () => {
  const handle = await spawnExtensionProcess();
  try {
    const result = await measureHeap(handle);
    assertEquals(result.status, "heap");
    assertEquals(typeof result.bytes, "number");
  } finally {
    await killSubprocess(handle);
  }
});
