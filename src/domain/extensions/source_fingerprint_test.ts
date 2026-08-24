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

// SourceFingerprint is a value type: an opaque string compared by
// equality, produced by computeSourceFingerprint. These tests pin the
// rebundle/staleness contract of that value — equal fingerprint means
// "same content graph, no rebundle"; any content, dep-set, or path
// change must yield a different value; and the value must be a pure,
// deterministic function of the content graph (never of mtimes or
// unrelated files).

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import type { SourceFingerprint } from "./source_fingerprint.ts";
import {
  computeSourceFingerprint,
  createFreshnessCache,
} from "./bundle_freshness.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_source_fp_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const ENTRY_SOURCE =
  "import { greeting } from './dep.ts';\nexport const g = greeting;\n";
const DEP_SOURCE = "export const greeting = 'hello';\n";

async function writeEntryAndDep(
  dir: string,
): Promise<{ entry: string; dep: string }> {
  const entry = join(dir, "entry.ts");
  const dep = join(dir, "dep.ts");
  await Deno.writeTextFile(entry, ENTRY_SOURCE);
  await Deno.writeTextFile(dep, DEP_SOURCE);
  return { entry, dep };
}

// ── Identity: same content graph → same fingerprint ───────────────────

Deno.test("computeSourceFingerprint: identical content yields identical fingerprint (no rebundle)", async () => {
  await withTempDir(async (dir) => {
    const { entry, dep } = await writeEntryAndDep(dir);
    const first: SourceFingerprint = await computeSourceFingerprint(
      entry,
      dir,
    );

    // Rewrite both files with identical bytes — a fresh write, new
    // mtimes, same content graph.
    await Deno.writeTextFile(entry, ENTRY_SOURCE);
    await Deno.writeTextFile(dep, DEP_SOURCE);
    const second: SourceFingerprint = await computeSourceFingerprint(
      entry,
      dir,
    );
    assertEquals(second, first);
  });
});

Deno.test("computeSourceFingerprint: deterministic across repeated runs and cache instances", async () => {
  await withTempDir(async (dir) => {
    const { entry } = await writeEntryAndDep(dir);

    const noCache = await computeSourceFingerprint(entry, dir);
    const cacheA = createFreshnessCache();
    const withCacheA = await computeSourceFingerprint(entry, dir, cacheA);
    const repeatCacheA = await computeSourceFingerprint(entry, dir, cacheA);
    const cacheB = createFreshnessCache();
    const withCacheB = await computeSourceFingerprint(entry, dir, cacheB);

    assertEquals(withCacheA, noCache);
    assertEquals(repeatCacheA, noCache);
    assertEquals(withCacheB, noCache);
  });
});

Deno.test("computeSourceFingerprint: identical content trees in different directories share a fingerprint", async () => {
  await withTempDir(async (dirA) => {
    await withTempDir(async (dirB) => {
      const a = await writeEntryAndDep(dirA);
      const b = await writeEntryAndDep(dirB);

      const fpA = await computeSourceFingerprint(a.entry, dirA);
      const fpB = await computeSourceFingerprint(b.entry, dirB);
      assertEquals(
        fpA,
        fpB,
        "fingerprint identifies the content graph, not its location",
      );
    });
  });
});

Deno.test("computeSourceFingerprint: mtime-only change leaves fingerprint unchanged", async () => {
  await withTempDir(async (dir) => {
    const { entry, dep } = await writeEntryAndDep(dir);
    const before = await computeSourceFingerprint(entry, dir);

    const later = new Date(Date.now() + 60_000);
    await Deno.utime(entry, later, later);
    await Deno.utime(dep, later, later);

    const after = await computeSourceFingerprint(entry, dir);
    assertEquals(after, before, "content-based, not mtime-based");
  });
});

Deno.test("computeSourceFingerprint: unimported sibling files do not affect the fingerprint", async () => {
  await withTempDir(async (dir) => {
    const { entry } = await writeEntryAndDep(dir);
    const before = await computeSourceFingerprint(entry, dir);

    await Deno.writeTextFile(
      join(dir, "unrelated.ts"),
      "export const noise = 42;\n",
    );

    const after = await computeSourceFingerprint(entry, dir);
    assertEquals(after, before);
  });
});

// ── Change detection: content, additions, removals ────────────────────

Deno.test("computeSourceFingerprint: content edit changes the value and reverting restores it", async () => {
  await withTempDir(async (dir) => {
    const { entry, dep } = await writeEntryAndDep(dir);
    const original = await computeSourceFingerprint(entry, dir);

    await Deno.writeTextFile(dep, "export const greeting = 'goodbye';\n");
    const edited = await computeSourceFingerprint(entry, dir);
    assertNotEquals(edited, original);

    await Deno.writeTextFile(dep, DEP_SOURCE);
    const reverted = await computeSourceFingerprint(entry, dir);
    assertEquals(
      reverted,
      original,
      "fingerprint is a pure function of the content graph",
    );
  });
});

Deno.test("computeSourceFingerprint: adding an imported file changes the fingerprint", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    await Deno.writeTextFile(entry, "export const x = 1;\n");
    const standalone = await computeSourceFingerprint(entry, dir);

    await Deno.writeTextFile(
      join(dir, "extra.ts"),
      "export const extra = 2;\n",
    );
    await Deno.writeTextFile(
      entry,
      "import { extra } from './extra.ts';\nexport const x = extra;\n",
    );
    const withDep = await computeSourceFingerprint(entry, dir);
    assertNotEquals(withDep, standalone);
  });
});

Deno.test("computeSourceFingerprint: removing a dependency file changes the fingerprint; restoring it restores the value", async () => {
  await withTempDir(async (dir) => {
    const { entry, dep } = await writeEntryAndDep(dir);
    const healthy = await computeSourceFingerprint(entry, dir);

    // Delete the imported file — the entry point's bytes are unchanged
    // but the content graph is now broken, so the value must move.
    await Deno.remove(dep);
    const broken = await computeSourceFingerprint(entry, dir);
    assertNotEquals(broken, healthy);

    // Restoring identical content restores the original value — no
    // rebundle is needed once the graph is byte-identical again.
    await Deno.writeTextFile(dep, DEP_SOURCE);
    const restored = await computeSourceFingerprint(entry, dir);
    assertEquals(restored, healthy);
  });
});

Deno.test("computeSourceFingerprint: broken dependency state is stable across runs (no rebundle loop)", async () => {
  await withTempDir(async (dir) => {
    const { entry, dep } = await writeEntryAndDep(dir);
    await Deno.remove(dep);

    const firstBroken = await computeSourceFingerprint(entry, dir);
    const secondBroken = await computeSourceFingerprint(entry, dir);
    assertEquals(
      secondBroken,
      firstBroken,
      "same broken state must produce the same value on every run",
    );
  });
});

Deno.test("computeSourceFingerprint: transitive content change through an import chain is detected", async () => {
  await withTempDir(async (dir) => {
    const entry = join(dir, "entry.ts");
    const mid = join(dir, "mid.ts");
    const leaf = join(dir, "leaf.ts");
    await Deno.writeTextFile(
      entry,
      "import { m } from './mid.ts';\nexport const e = m;\n",
    );
    await Deno.writeTextFile(
      mid,
      "import { l } from './leaf.ts';\nexport const m = l;\n",
    );
    await Deno.writeTextFile(leaf, "export const l = 1;\n");
    const before = await computeSourceFingerprint(entry, dir);

    await Deno.writeTextFile(leaf, "export const l = 2;\n");
    const after = await computeSourceFingerprint(entry, dir);
    assertNotEquals(
      after,
      before,
      "a leaf edit two imports deep must invalidate the entry point",
    );
  });
});
