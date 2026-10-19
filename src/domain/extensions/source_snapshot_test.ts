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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { SourceModuleLookup } from "./bundle_freshness.ts";
import {
  captureSourceSnapshot,
  sourceSnapshotChanged,
  StaleExtensionSourceError,
} from "./source_snapshot.ts";

const NO_MODULES: SourceModuleLookup = { findSourceModules: () => undefined };

async function withSources(
  fn: (dir: string, entry: string, helper: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const entry = join(dir, "model.ts");
    const helper = join(dir, "_lib", "helper.ts");
    await Deno.mkdir(join(dir, "_lib"));
    await Deno.writeTextFile(entry, "export const v = 1;\n");
    await Deno.writeTextFile(helper, "export const h = 1;\n");
    await fn(dir, entry, helper);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("sourceSnapshotChanged: false while the source is unchanged", async () => {
  await withSources(async (_dir, entry) => {
    const snapshot = await captureSourceSnapshot(entry, NO_MODULES);
    assertEquals(await sourceSnapshotChanged(snapshot), false);
  });
});

Deno.test("sourceSnapshotChanged: true once the entry's content changes, even at the same length", async () => {
  await withSources(async (_dir, entry) => {
    const snapshot = await captureSourceSnapshot(entry, NO_MODULES);
    await Deno.writeTextFile(entry, "export const v = 2;\n");
    assertEquals(await sourceSnapshotChanged(snapshot), true);
  });
});

Deno.test("sourceSnapshotChanged: false when the entry is rewritten with the same content", async () => {
  await withSources(async (_dir, entry) => {
    const snapshot = await captureSourceSnapshot(entry, NO_MODULES);
    await Deno.remove(entry);
    await Deno.writeTextFile(entry, "export const v = 1;\n");
    assertEquals(await sourceSnapshotChanged(snapshot), false);
  });
});

Deno.test("sourceSnapshotChanged: true once the entry is removed", async () => {
  await withSources(async (_dir, entry) => {
    const snapshot = await captureSourceSnapshot(entry, NO_MODULES);
    await Deno.remove(entry);
    assertEquals(await sourceSnapshotChanged(snapshot), true);
  });
});

Deno.test("sourceSnapshotChanged: covers the local modules the catalog recorded", async () => {
  await withSources(async (_dir, entry, helper) => {
    const snapshot = await captureSourceSnapshot(entry, {
      findSourceModules: (path) => path === entry ? [helper] : undefined,
    });
    assertEquals(snapshot.files, [entry, helper]);
    await Deno.writeTextFile(helper, "export const h = 2;\n");
    assertEquals(await sourceSnapshotChanged(snapshot), true);
  });
});

Deno.test("sourceSnapshotChanged: without recorded modules, covers the entry's relative imports", async () => {
  await withSources(async (_dir, entry, helper) => {
    await Deno.writeTextFile(
      entry,
      'import { h } from "./_lib/helper.ts";\nexport const v = h;\n',
    );
    const snapshot = await captureSourceSnapshot(entry, NO_MODULES);
    assertEquals(snapshot.files.includes(helper), true);
    assertEquals(await sourceSnapshotChanged(snapshot), false);

    // A pull that changes only a helper module.
    await Deno.writeTextFile(helper, "export const h = 2;\n");
    assertEquals(await sourceSnapshotChanged(snapshot), true);
  });
});

Deno.test("StaleExtensionSourceError: names the type and extension and says how to recover", () => {
  const error = new StaleExtensionSourceError("@acme/thing", "@acme/ext");
  assertEquals(error.name, "StaleExtensionSourceError");
  assertStringIncludes(error.message, "@acme/thing");
  assertStringIncludes(error.message, "@acme/ext");
  assertStringIncludes(error.message, "swamp serve reload");
});
