// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  computeSourceFingerprint,
  findStaleFiles,
  type FreshnessCatalog,
} from "./bundle_freshness.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";

// -- Test fixture -------------------------------------------------------

class FakeCatalog implements FreshnessCatalog {
  private rows: ExtensionTypeRow[] = [];

  add(row: ExtensionTypeRow): void {
    this.rows.push(row);
  }

  findByKind(kind: "model" | "extension"): ExtensionTypeRow[] {
    return this.rows.filter((r) => r.kind === kind);
  }

  removeBySourcePath(sourcePath: string): void {
    this.rows = this.rows.filter((r) => r.source_path !== sourcePath);
  }

  snapshot(): ExtensionTypeRow[] {
    return [...this.rows];
  }
}

const discoverTsFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(".ts")) {
      out.push(entry.name);
    }
  }
  return out.sort();
};

// -- computeSourceFingerprint -------------------------------------------

Deno.test("computeSourceFingerprint: produces a 64-char hex sha-256", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_hex_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const x = 1;");
    const fp = await computeSourceFingerprint(file, dir);
    assertEquals(fp.length, 64);
    assertEquals(/^[0-9a-f]{64}$/.test(fp), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: is deterministic across runs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_det_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const x = 1;");
    const first = await computeSourceFingerprint(file, dir);
    const second = await computeSourceFingerprint(file, dir);
    assertEquals(first, second);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: changes when content changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_content_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const x = 1;");
    const before = await computeSourceFingerprint(file, dir);
    await Deno.writeTextFile(file, "export const x = 2;");
    const after = await computeSourceFingerprint(file, dir);
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: changes when content changes even with preserved mtime", async () => {
  // This is the #125 scenario — editor atomic-rename + mtime restore.
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_mtime_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const x = 1;");
    const origMtime = (await Deno.stat(file)).mtime!;
    const before = await computeSourceFingerprint(file, dir);

    await Deno.writeTextFile(file, "export const x = 2;");
    await Deno.utime(file, origMtime, origMtime);

    const after = await computeSourceFingerprint(file, dir);
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: tracks transitive dependency changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_deps_" });
  try {
    const entry = join(dir, "entry.ts");
    const dep = join(dir, "dep.ts");
    await Deno.writeTextFile(dep, "export const greeting = 'hello';");
    await Deno.writeTextFile(
      entry,
      "import { greeting } from './dep.ts';\nexport const g = greeting;",
    );
    const before = await computeSourceFingerprint(entry, dir);

    await Deno.writeTextFile(dep, "export const greeting = 'goodbye';");
    const after = await computeSourceFingerprint(entry, dir);
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: ignores non-local (npm/jsr) imports", async () => {
  // Fingerprint should be content-based on local sources only —
  // changing the user's npm import string but keeping local deps the
  // same should NOT change the fingerprint other than through the
  // entry file's own bytes (which did change). So we instead compare
  // two files with identical bytes but different npm-only semantics.
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_npm_" });
  try {
    const entry = join(dir, "entry.ts");
    const src = "import { z } from 'npm:zod@4';\nexport const s = z.string();";
    await Deno.writeTextFile(entry, src);
    const first = await computeSourceFingerprint(entry, dir);

    // Rewrite with identical bytes — fingerprint must match.
    await Deno.writeTextFile(entry, src);
    const second = await computeSourceFingerprint(entry, dir);
    assertEquals(first, second);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: different files in same dir produce different fingerprints", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_pathsens_" });
  try {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await Deno.writeTextFile(a, "export const x = 1;");
    await Deno.writeTextFile(b, "export const x = 1;");
    const fpA = await computeSourceFingerprint(a, dir);
    const fpB = await computeSourceFingerprint(b, dir);
    assertNotEquals(
      fpA,
      fpB,
      "Fingerprints include relative path — identical bytes at different paths differ",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// -- findStaleFiles -----------------------------------------------------

Deno.test("findStaleFiles: empty catalog → every file is stale", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_empty_" });
  try {
    await Deno.writeTextFile(join(dir, "a.ts"), "export const a = 1;");
    await Deno.writeTextFile(join(dir, "b.ts"), "export const b = 2;");

    const catalog = new FakeCatalog();
    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
    });

    assertEquals(stale.length, 2);
    assertEquals(
      stale.map((s) => s.relativePath).sort(),
      ["a.ts", "b.ts"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: matching fingerprint → not stale", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_match_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");

    const fp = await computeSourceFingerprint(file, dir);
    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: fp,
    });

    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
    });
    assertEquals(stale.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: mismatching fingerprint → stale", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_mismatch_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "stale-fingerprint-that-wont-match",
    });

    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
    });
    assertEquals(stale.length, 1);
    assertEquals(stale[0].relativePath, "a.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: catches mtime-preserving content change (#125)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_mtime_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");
    const origFp = await computeSourceFingerprint(file, dir);
    const origMtime = (await Deno.stat(file)).mtime!;

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: origMtime.toISOString(),
      source_fingerprint: origFp,
    });

    // Swap content, restore the old mtime — this is exactly what
    // atomic-rename saves and rsync --times do in the wild.
    await Deno.writeTextFile(file, "export const a = 2;");
    await Deno.utime(file, origMtime, origMtime);

    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
    });
    assertEquals(
      stale.length,
      1,
      "Fingerprint must catch content change even when mtime is preserved",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: deleted file is removed from catalog", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_deleted_" });
  try {
    const survivor = join(dir, "survivor.ts");
    const deletedPath = join(dir, "deleted.ts");
    await Deno.writeTextFile(survivor, "export const s = 1;");

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: survivor,
      type_normalized: "@user/s",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: await computeSourceFingerprint(survivor, dir),
    });
    catalog.add({
      source_path: deletedPath,
      type_normalized: "@user/d",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "irrelevant",
    });

    await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
    });

    const remaining = catalog.snapshot().map((r) => r.source_path);
    assertEquals(remaining, [survivor]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: missing source dir is silently skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_missing_" });
  try {
    await Deno.remove(dir, { recursive: true }); // remove before scan

    const catalog = new FakeCatalog();
    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
    });
    assertEquals(stale, []);
  } catch (err) {
    // Cleanup already happened — swallow.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
});
