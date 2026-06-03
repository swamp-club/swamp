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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import {
  importInSubprocess,
  killSubprocess,
  spawnExtensionProcess,
  type SubprocessHandle,
} from "../../infrastructure/testing/subprocess_harness.ts";

const EXTENSION_KINDS: Array<{ kind: string; exportKey: string }> = [
  { kind: "model", exportKey: "model" },
  { kind: "vault", exportKey: "vault" },
  { kind: "driver", exportKey: "driver" },
  { kind: "datastore", exportKey: "datastore" },
  { kind: "report", exportKey: "report" },
];

function bundleContent(exportKey: string, version: string): string {
  return `export const ${exportKey} = { name: "test-${exportKey}", version: "${version}" };\n`;
}

for (const { kind, exportKey } of EXTENSION_KINDS) {
  Deno.test(`module-reload(${kind}): distinct fingerprints see fresh module`, async () => {
    const dir = await Deno.makeTempDir({ prefix: `swamp_reload_${kind}_` });
    let handle: SubprocessHandle | undefined;
    try {
      const bundlePath = join(dir, `test_${kind}.js`);
      await Deno.writeTextFile(bundlePath, bundleContent(exportKey, "v1"));

      handle = await spawnExtensionProcess();

      const r1 = await importInSubprocess(
        handle,
        bundlePath,
        "fp-v1",
        exportKey,
      );
      assertEquals(r1.status, "ok");
      assertEquals(r1.hasExport, true);
      assertEquals(r1.version, "v1");

      await Deno.writeTextFile(bundlePath, bundleContent(exportKey, "v2"));

      const r2 = await importInSubprocess(
        handle,
        bundlePath,
        "fp-v2",
        exportKey,
      );
      assertEquals(r2.status, "ok");
      assertEquals(r2.hasExport, true);
      assertEquals(r2.version, "v2");
      assertNotEquals(r1.fingerprint, r2.fingerprint);
    } finally {
      if (handle) await killSubprocess(handle);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}

Deno.test("fingerprint-collision: same fingerprint returns same cached module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_collision_" });
  let handle: SubprocessHandle | undefined;
  try {
    const bundlePath = join(dir, "collision.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "original" };\n',
    );

    handle = await spawnExtensionProcess();

    const r1 = await importInSubprocess(
      handle,
      bundlePath,
      "shared-fp",
      "model",
    );
    assertEquals(r1.status, "ok");

    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "modified" };\n',
    );

    const r2 = await importInSubprocess(
      handle,
      bundlePath,
      "shared-fp",
      "model",
    );
    assertEquals(r2.status, "ok");
    assertEquals(r2.fingerprint, "shared-fp");
  } finally {
    if (handle) await killSubprocess(handle);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("fingerprint-divergence: same path different fingerprints are distinct", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_diverge_" });
  let handle: SubprocessHandle | undefined;
  try {
    const bundlePath = join(dir, "diverge.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "base" };\n',
    );

    handle = await spawnExtensionProcess();

    const r1 = await importInSubprocess(
      handle,
      bundlePath,
      "fp-alpha",
      "model",
    );
    assertEquals(r1.status, "ok");

    const r2 = await importInSubprocess(handle, bundlePath, "fp-beta", "model");
    assertEquals(r2.status, "ok");
    assertNotEquals(r1.fingerprint, r2.fingerprint);

    const r3 = await importInSubprocess(
      handle,
      bundlePath,
      "fp-alpha",
      "model",
    );
    assertEquals(r3.status, "ok");
    assertEquals(r3.fingerprint, "fp-alpha");
  } finally {
    if (handle) await killSubprocess(handle);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("empty-fingerprint: no query parameter produces bare URL import", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_fp_empty_" });
  let handle: SubprocessHandle | undefined;
  try {
    const bundlePath = join(dir, "legacy.js");
    await Deno.writeTextFile(
      bundlePath,
      'export const model = { name: "legacy-model" };\n',
    );

    handle = await spawnExtensionProcess();

    const r1 = await importInSubprocess(handle, bundlePath, "", "model");
    assertEquals(r1.status, "ok");
    assertEquals(r1.hasExport, true);
    assertEquals(r1.fingerprint, "");
  } finally {
    if (handle) await killSubprocess(handle);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
