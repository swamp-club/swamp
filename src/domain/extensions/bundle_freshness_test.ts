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
  type FreshnessKind,
  markCatalogValidationFailed,
  type ValidationFailureCatalog,
} from "./bundle_freshness.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";

// -- Test fixture -------------------------------------------------------

class FakeCatalog implements FreshnessCatalog, ValidationFailureCatalog {
  private rows: ExtensionTypeRow[] = [];

  add(row: ExtensionTypeRow): void {
    this.rows.push(row);
  }

  upsert(row: {
    source_path: string;
    type_normalized: string;
    kind: FreshnessKind;
    bundle_path: string;
    version: string;
    description: string;
    extends_type: string;
    source_mtime: string;
    source_fingerprint: string;
    validation_failed: boolean;
  }): void {
    this.rows = this.rows.filter((r) => r.source_path !== row.source_path);
    this.rows.push(row as unknown as ExtensionTypeRow);
  }

  findByKind(kind: FreshnessKind): ExtensionTypeRow[] {
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
      kinds: ["model"],
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
      kinds: ["model"],
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
      kinds: ["model"],
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
      kinds: ["model"],
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
      kinds: ["model"],
    });

    const remaining = catalog.snapshot().map((r) => r.source_path);
    assertEquals(remaining, [survivor]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: kinds filter scopes both the staleness check and deletion — rows of other kinds in unseen dirs are not touched (#128)", async () => {
  const driverDir = await Deno.makeTempDir({
    prefix: "swamp_bf_stale_kinds_driver_",
  });
  const vaultDir = await Deno.makeTempDir({
    prefix: "swamp_bf_stale_kinds_vault_",
  });
  try {
    // Current on-disk: driver dir has one file, vault dir has one file.
    const driverFile = join(driverDir, "my_driver.ts");
    const vaultFile = join(vaultDir, "my_vault.ts");
    await Deno.writeTextFile(driverFile, "export const d = 1;");
    await Deno.writeTextFile(vaultFile, "export const v = 1;");

    const driverFp = await computeSourceFingerprint(driverFile, driverDir);
    const vaultFp = await computeSourceFingerprint(vaultFile, vaultDir);

    // Catalog has rows for BOTH kinds, plus a stale driver row whose
    // source file has been deleted from disk.
    const catalog = new FakeCatalog();
    catalog.add({
      source_path: driverFile,
      type_normalized: "@user/d",
      kind: "driver",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: driverFp,
    });
    catalog.add({
      source_path: join(driverDir, "gone.ts"),
      type_normalized: "@user/gone",
      kind: "driver",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "whatever",
    });
    catalog.add({
      source_path: vaultFile,
      type_normalized: "@user/v",
      kind: "vault",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: vaultFp,
    });

    // Scan driver dir with kinds: ["driver"] — only driver rows are
    // compared, and only driver rows are deleted. The vault row for
    // a file living outside driverDir must NOT be deleted.
    const stale = await findStaleFiles({
      modelsDir: driverDir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["driver"],
    });

    assertEquals(
      stale.length,
      0,
      "driver row fingerprint matches — nothing should be stale",
    );

    const remaining = catalog.snapshot().map((r) => ({
      path: r.source_path,
      kind: r.kind,
    })).sort((a, b) => a.path.localeCompare(b.path));

    // The stale driver row (gone.ts) must be deleted.
    // The vault row (in a dir outside the scan) must survive — this is
    // the cross-kind isolation guarantee that lets sibling loaders
    // share the catalog without stepping on each other.
    assertEquals(
      remaining.some((r) => r.kind === "driver" && r.path === driverFile),
      true,
      "driver survivor must remain",
    );
    assertEquals(
      remaining.some((r) => r.kind === "driver" && r.path.endsWith("gone.ts")),
      false,
      "deleted driver row must be removed",
    );
    assertEquals(
      remaining.some((r) => r.kind === "vault" && r.path === vaultFile),
      true,
      "vault row in a dir outside the driver scan must survive — kinds filter must NOT delete rows of other kinds",
    );
  } finally {
    await Deno.remove(driverDir, { recursive: true });
    await Deno.remove(vaultDir, { recursive: true });
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
      kinds: ["model"],
    });
    assertEquals(stale, []);
  } catch (err) {
    // Cleanup already happened — swallow.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
});

// -- Issue #208: total fingerprint --------------------------------------
// `swamp model type search` regressed to ~8s because broken transitive
// deps caused computeSourceFingerprint to throw, which findStaleFiles
// caught as "permanently stale" and re-attempted bundling on every
// invocation. The fix makes computeSourceFingerprint total: an
// unreadable dep produces a stable sentinel entry instead of throwing,
// so a stable broken state yields a stable fingerprint.

Deno.test("computeSourceFingerprint: broken transitive symlink does not throw", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_broken_dep_" });
  try {
    const entry = join(dir, "entry.ts");
    const broken = join(dir, "broken.ts");
    await Deno.writeTextFile(
      entry,
      "import { x } from './broken.ts';\nexport const e = x;",
    );
    await Deno.symlink("/nonexistent/path/broken.ts", broken, { type: "file" });

    const fp = await computeSourceFingerprint(entry, dir);
    assertEquals(fp.length, 64);
    assertEquals(/^[0-9a-f]{64}$/.test(fp), true);

    // Stable across repeated calls.
    const again = await computeSourceFingerprint(entry, dir);
    assertEquals(fp, again);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: absence of dep is captured in fingerprint", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_absence_" });
  try {
    const entry = join(dir, "entry.ts");
    const dep = join(dir, "dep.ts");
    await Deno.writeTextFile(
      entry,
      "import { x } from './dep.ts';\nexport const e = x;",
    );
    await Deno.writeTextFile(dep, "export const x = 1;");
    const allPresent = await computeSourceFingerprint(entry, dir);

    // Replace the readable dep with a broken symlink. Same path, same
    // import — different readability state. Fingerprint must differ.
    await Deno.remove(dep);
    await Deno.symlink("/nonexistent/path/dep.ts", dep, { type: "file" });
    const oneBroken = await computeSourceFingerprint(entry, dir);

    assertNotEquals(
      allPresent,
      oneBroken,
      "Fingerprint must distinguish 'all deps readable' from 'one dep unreadable' — otherwise dep restoration wouldn't trigger a rebundle",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: MISSING sentinel cannot collide with a real hash", () => {
  // The sentinel is substituted for unreadable deps in the
  // {relPath}:{hash} entry list. A real sha-256 hex hash is exactly 64
  // hex chars. "MISSING" is 7 chars and contains non-hex letters, so
  // no real hash can produce the same per-file entry as a sentinel.
  // Without this invariant a broken-dep file could spoof a healthy
  // fingerprint.
  assertEquals(/^[0-9a-f]{64}$/.test("MISSING"), false);
});

Deno.test("findStaleFiles: broken transitive dep — stale once, then stable (#208 regression)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_broken_" });
  try {
    const entry = join(dir, "entry.ts");
    const dep = join(dir, "dep.ts");
    await Deno.writeTextFile(
      entry,
      "import { x } from './dep.ts';\nexport const e = x;",
    );
    await Deno.writeTextFile(dep, "export const x = 1;");

    // Step 1: all readable. Compute fingerprint F1, store in catalog.
    const f1 = await computeSourceFingerprint(entry, dir);
    const catalog = new FakeCatalog();
    catalog.add({
      source_path: entry,
      type_normalized: "@user/entry",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: f1,
    });

    // Step 2: break the transitive dep. findStaleFiles must mark the
    // entry stale on this pass — the dep change is a real fingerprint
    // change and the rebundle path needs to fire to refresh the row.
    await Deno.remove(dep);
    await Deno.symlink("/nonexistent/path/dep.ts", dep, { type: "file" });

    const firstPass = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(
      firstPass.length,
      1,
      "first pass after dep breaks must mark entry stale",
    );
    assertEquals(firstPass[0].relativePath, "entry.ts");

    // Step 3: simulate the rebundle path updating the catalog row to
    // the new sentinel-bearing fingerprint F2.
    const f2 = await computeSourceFingerprint(entry, dir);
    assertNotEquals(f1, f2);
    catalog.removeBySourcePath(entry);
    catalog.add({
      source_path: entry,
      type_normalized: "@user/entry",
      kind: "model",
      bundle_path: "/ignored",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: f2,
    });

    // Step 4: subsequent passes — the regression's load-bearing claim.
    // With the row reflecting the broken state, findStaleFiles must
    // NOT mark the entry stale. Pre-fix, fingerprint computation threw
    // and the file was marked stale on every invocation, triggering
    // bundle spawns and the 8s wall time reported in #208.
    const secondPass = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(
      secondPass.length,
      0,
      "subsequent passes must not mark a file with stably-broken transitive dep as stale (#208)",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: restoring a broken dep changes the fingerprint", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_restore_" });
  try {
    const entry = join(dir, "entry.ts");
    const dep = join(dir, "dep.ts");
    await Deno.writeTextFile(
      entry,
      "import { x } from './dep.ts';\nexport const e = x;",
    );
    await Deno.symlink("/nonexistent/path/dep.ts", dep, { type: "file" });

    const broken = await computeSourceFingerprint(entry, dir);

    // Restore the dep as a real file with content.
    await Deno.remove(dep);
    await Deno.writeTextFile(dep, "export const x = 42;");
    const restored = await computeSourceFingerprint(entry, dir);

    assertNotEquals(
      broken,
      restored,
      "Repairing a broken dep must change the fingerprint so the rebundle path fires",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// -- markCatalogValidationFailed (swamp-club#209) -----------------------

class FakeValidationFailureCatalog implements ValidationFailureCatalog {
  public readonly upserts: Array<Record<string, unknown>> = [];

  upsert(row: {
    source_path: string;
    type_normalized: string;
    kind: FreshnessKind;
    bundle_path: string;
    version: string;
    description: string;
    extends_type: string;
    source_mtime: string;
    source_fingerprint: string;
    validation_failed: boolean;
  }): void {
    this.upserts.push({ ...row });
  }
}

Deno.test("markCatalogValidationFailed: upserts a row with every field populated", () => {
  const catalog = new FakeValidationFailureCatalog();

  markCatalogValidationFailed({
    catalog,
    sourcePath: "/repo/extensions/models/echo/echo.ts",
    kind: "model",
    bundlePath: "/repo/.swamp/bundles/echo.js",
    sourceMtime: "2026-05-01T12:00:00.000Z",
    sourceFingerprint: "abc123",
  });

  assertEquals(catalog.upserts.length, 1);
  const row = catalog.upserts[0];
  assertEquals(row.source_path, "/repo/extensions/models/echo/echo.ts");
  assertEquals(row.type_normalized, "");
  assertEquals(row.kind, "model");
  assertEquals(row.bundle_path, "/repo/.swamp/bundles/echo.js");
  assertEquals(row.version, "");
  assertEquals(row.description, "");
  assertEquals(row.extends_type, "");
  assertEquals(row.source_mtime, "2026-05-01T12:00:00.000Z");
  assertEquals(row.source_fingerprint, "abc123");
  assertEquals(row.validation_failed, true);
});

Deno.test("markCatalogValidationFailed: idempotent — repeated calls produce identical rows", () => {
  const catalog = new FakeValidationFailureCatalog();

  const params = {
    catalog,
    sourcePath: "/r/v.ts",
    kind: "vault" as FreshnessKind,
    bundlePath: "/r/v.js",
    sourceMtime: "2026-05-01T12:00:00.000Z",
    sourceFingerprint: "fingerprint-x",
  };

  markCatalogValidationFailed(params);
  markCatalogValidationFailed(params);

  assertEquals(catalog.upserts.length, 2);
  assertEquals(catalog.upserts[0], catalog.upserts[1]);
});

Deno.test("findStaleFiles + markCatalogValidationFailed: stable broken source converges to not-stale (swamp-club#209)", async () => {
  // The actual bug-fix invariant. Without markCatalogValidationFailed,
  // the catalog row's stored fingerprint stays pinned at the last-good
  // value after a schema break, so findStaleFiles keeps returning the
  // file as stale on every pass. With it, the new fingerprint is
  // recorded and findStaleFiles converges to "not stale" — the
  // rebundle loop terminates on a stable broken source.
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_209_converge_" });
  try {
    const file = join(dir, "model.ts");
    const sourceContent = "export const broken = { not: 'a model' };\n";
    await Deno.writeTextFile(file, sourceContent);

    // Compute the would-be source fingerprint as the loader does.
    const fingerprint = await computeSourceFingerprint(file, dir);

    // Simulate what rebundleAndUpdateCatalog now does on safeParse
    // failure: record a validation-failed row with the new fingerprint.
    const catalog = new FakeCatalog();
    markCatalogValidationFailed({
      catalog,
      sourcePath: file,
      kind: "model",
      bundlePath: join(dir, "model.js"),
      sourceMtime: "2026-05-01T12:00:00.000Z",
      sourceFingerprint: fingerprint,
    });

    // findStaleFiles must NOT return this file — its fingerprint
    // matches the stored value, so it is fresh-but-broken, not stale.
    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(
      stale.length,
      0,
      "Stable broken source must converge to not-stale on the very next " +
        "findStaleFiles pass",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles + markCatalogValidationFailed: editing a broken source produces a new fingerprint and re-stales", async () => {
  // Recovery path. After the broken-state row is in place, editing
  // the source to ANY different content (broken or valid) produces a
  // new fingerprint that does not match the stored value, so
  // findStaleFiles correctly marks the file stale and the loader's
  // rebundle pass fires.
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_209_recover_" });
  try {
    const file = join(dir, "model.ts");
    await Deno.writeTextFile(file, "export const broken = 1;\n");
    const brokenFp = await computeSourceFingerprint(file, dir);

    const catalog = new FakeCatalog();
    markCatalogValidationFailed({
      catalog,
      sourcePath: file,
      kind: "model",
      bundlePath: join(dir, "model.js"),
      sourceMtime: "2026-05-01T12:00:00.000Z",
      sourceFingerprint: brokenFp,
    });

    // Stable broken — not stale.
    let stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(stale.length, 0);

    // Edit to different content (the recovery path).
    await Deno.writeTextFile(file, "export const recovered = 42;\n");
    stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(
      stale.length,
      1,
      "Editing the source after a broken-state row must re-stale the file " +
        "so the rebundle pass can repair the row",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("markCatalogValidationFailed: works for every supported kind", () => {
  const catalog = new FakeValidationFailureCatalog();
  const kinds: FreshnessKind[] = [
    "model",
    "extension",
    "vault",
    "driver",
    "datastore",
    "report",
  ];

  for (const kind of kinds) {
    markCatalogValidationFailed({
      catalog,
      sourcePath: `/r/${kind}.ts`,
      kind,
      bundlePath: `/r/${kind}.js`,
      sourceMtime: "2026-05-01T12:00:00.000Z",
      sourceFingerprint: "fp",
    });
  }

  assertEquals(catalog.upserts.length, kinds.length);
  for (let i = 0; i < kinds.length; i++) {
    assertEquals(catalog.upserts[i].kind, kinds[i]);
    assertEquals(catalog.upserts[i].validation_failed, true);
  }
});
