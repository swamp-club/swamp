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
import { join, SEPARATOR } from "@std/path";
import {
  collectSeenSources,
  computeSourceFingerprint,
  findStaleFiles,
  type FreshnessCatalog,
  type FreshnessKind,
  normalizeFreshnessPath,
  scanCatalogFreshness,
  type SourceModuleLookup,
} from "./bundle_freshness.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";

const noRecordedModules: SourceModuleLookup = {
  findSourceModules: () => undefined,
};

class FakeCatalog implements FreshnessCatalog {
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

  removeByRawSourcePath(rawSourcePath: string): void {
    this.rows = this.rows.filter((r) => r.source_path !== rawSourcePath);
  }

  readonly sourceModules = new Map<string, readonly string[]>();

  findSourceModules(sourcePath: string): readonly string[] | undefined {
    return this.sourceModules.get(sourcePath);
  }

  deleteSourceModules(sourcePath: string): void {
    this.sourceModules.delete(sourcePath);
    this.graphPending.delete(sourcePath);
  }

  readonly graphPending = new Set<string>();

  isSourceGraphPending(sourcePath: string): boolean {
    return this.graphPending.has(sourcePath);
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

Deno.test("computeSourceFingerprint: produces a 64-char hex sha-256", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_hex_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const x = 1;");
    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);
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
    const first = await computeSourceFingerprint(file, dir, noRecordedModules);
    const second = await computeSourceFingerprint(file, dir, noRecordedModules);
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
    const before = await computeSourceFingerprint(file, dir, noRecordedModules);
    await Deno.writeTextFile(file, "export const x = 2;");
    const after = await computeSourceFingerprint(file, dir, noRecordedModules);
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: changes when content changes even with preserved mtime", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_mtime_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const x = 1;");
    const origMtime = (await Deno.stat(file)).mtime!;
    const before = await computeSourceFingerprint(file, dir, noRecordedModules);

    await Deno.writeTextFile(file, "export const x = 2;");
    await Deno.utime(file, origMtime, origMtime);

    const after = await computeSourceFingerprint(file, dir, noRecordedModules);
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
    const before = await computeSourceFingerprint(
      entry,
      dir,
      noRecordedModules,
    );

    await Deno.writeTextFile(dep, "export const greeting = 'goodbye';");
    const after = await computeSourceFingerprint(entry, dir, noRecordedModules);
    assertNotEquals(before, after);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: ignores non-local (npm/jsr) imports", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_fp_npm_" });
  try {
    const entry = join(dir, "entry.ts");
    const src = "import { z } from 'npm:zod@4';\nexport const s = z.string();";
    await Deno.writeTextFile(entry, src);
    const first = await computeSourceFingerprint(entry, dir, noRecordedModules);

    await Deno.writeTextFile(entry, src);
    const second = await computeSourceFingerprint(
      entry,
      dir,
      noRecordedModules,
    );
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
    const fpA = await computeSourceFingerprint(a, dir, noRecordedModules);
    const fpB = await computeSourceFingerprint(b, dir, noRecordedModules);
    assertNotEquals(
      fpA,
      fpB,
      "Fingerprints include relative path — identical bytes at different paths differ",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

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

    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);
    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: "",
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
      bundle_path: "",
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
    const origFp = await computeSourceFingerprint(file, dir, noRecordedModules);
    const origMtime = (await Deno.stat(file)).mtime!;

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: origMtime.toISOString(),
      source_fingerprint: origFp,
    });

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
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: await computeSourceFingerprint(
        survivor,
        dir,
        noRecordedModules,
      ),
    });
    catalog.add({
      source_path: deletedPath,
      type_normalized: "@user/d",
      kind: "model",
      bundle_path: "",
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
  const reportDir = await Deno.makeTempDir({
    prefix: "swamp_bf_stale_kinds_report_",
  });
  const vaultDir = await Deno.makeTempDir({
    prefix: "swamp_bf_stale_kinds_vault_",
  });
  try {
    const reportFile = join(reportDir, "my_report.ts");
    const vaultFile = join(vaultDir, "my_vault.ts");
    await Deno.writeTextFile(reportFile, "export const d = 1;");
    await Deno.writeTextFile(vaultFile, "export const v = 1;");

    const reportFp = await computeSourceFingerprint(
      reportFile,
      reportDir,
      noRecordedModules,
    );
    const vaultFp = await computeSourceFingerprint(
      vaultFile,
      vaultDir,
      noRecordedModules,
    );

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: reportFile,
      type_normalized: "@user/d",
      kind: "report",
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: reportFp,
    });
    catalog.add({
      source_path: join(reportDir, "gone.ts"),
      type_normalized: "@user/gone",
      kind: "report",
      bundle_path: "",
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
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: vaultFp,
    });

    const stale = await findStaleFiles({
      modelsDir: reportDir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["report"],
    });

    assertEquals(
      stale.length,
      0,
      "report row fingerprint matches — nothing should be stale",
    );

    const remaining = catalog.snapshot().map((r) => ({
      path: r.source_path,
      kind: r.kind,
    })).sort((a, b) => a.path.localeCompare(b.path));

    // the vault row outside the scan must survive: sibling loaders share the
    // catalog and must not delete each other's rows
    assertEquals(
      remaining.some((r) => r.kind === "report" && r.path === reportFile),
      true,
      "report survivor must remain",
    );
    assertEquals(
      remaining.some((r) => r.kind === "report" && r.path.endsWith("gone.ts")),
      false,
      "deleted report row must be removed",
    );
    assertEquals(
      remaining.some((r) => r.kind === "vault" && r.path === vaultFile),
      true,
      "vault row in a dir outside the report scan must survive — kinds filter must NOT delete rows of other kinds",
    );
  } finally {
    await Deno.remove(reportDir, { recursive: true });
    await Deno.remove(vaultDir, { recursive: true });
  }
});

Deno.test("findStaleFiles: missing source dir is silently skipped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_stale_missing_" });
  try {
    await Deno.remove(dir, { recursive: true });

    const catalog = new FakeCatalog();
    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(stale, []);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
});

Deno.test("findStaleFiles: matching fingerprint + missing bundle → stale (#212)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_212_missing_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");
    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: join(dir, "definitely-not-here.js"),
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
    assertEquals(stale.length, 1);
    assertEquals(stale[0].relativePath, "a.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: matching fingerprint + missing bundle + state=ValidationFailed → not stale (#212 vs #209)", async () => {
  // ValidationFailed rows skip the bundle-existence check; rebundling them
  // would undo what that state seals
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_212_validfail_" });
  try {
    const file = join(dir, "broken.ts");
    await Deno.writeTextFile(file, "export const broken = 1;");
    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "",
      kind: "model",
      bundle_path: join(dir, "definitely-not-here.js"),
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: fp,
      state: "ValidationFailed",
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

Deno.test("findStaleFiles: matching fingerprint + state=BundleBuildFailed → stale (issue #424)", async () => {
  // a transient bundle-build failure (empty bundle_path, unchanged fingerprint)
  // must be stale so the next scan retries, or a serve daemon stays broken
  // across restarts
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_424_buildfail_" });
  try {
    const file = join(dir, "needs_npm.ts");
    await Deno.writeTextFile(file, "export const needsNpm = 1;");
    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "",
      kind: "model",
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: fp,
      state: "BundleBuildFailed",
    });

    const stale = await findStaleFiles({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });
    assertEquals(stale.length, 1);
    assertEquals(stale[0].relativePath, "needs_npm.ts");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findStaleFiles: matching fingerprint + bundle exists → not stale (#212)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_212_present_" });
  try {
    const file = join(dir, "a.ts");
    const bundle = join(dir, "a.js");
    await Deno.writeTextFile(file, "export const a = 1;");
    await Deno.writeTextFile(bundle, "/* fake compiled bundle */");
    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: bundle,
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

Deno.test("findStaleFiles: empty bundle_path → bundle-existence check skipped (#212)", async () => {
  // rows without a bundle_path have nothing to stat, so they must not become
  // permanently stale
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_212_empty_path_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");
    const fp = await computeSourceFingerprint(file, dir, noRecordedModules);

    const catalog = new FakeCatalog();
    catalog.add({
      source_path: file,
      type_normalized: "@user/a",
      kind: "model",
      bundle_path: "",
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

// computeSourceFingerprint is total: an unreadable dep yields a stable sentinel
// entry instead of throwing, so a stable broken state gives a stable
// fingerprint

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

    const fp = await computeSourceFingerprint(entry, dir, noRecordedModules);
    assertEquals(fp.length, 64);
    assertEquals(/^[0-9a-f]{64}$/.test(fp), true);

    const again = await computeSourceFingerprint(entry, dir, noRecordedModules);
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
    const allPresent = await computeSourceFingerprint(
      entry,
      dir,
      noRecordedModules,
    );

    await Deno.remove(dep);
    await Deno.symlink("/nonexistent/path/dep.ts", dep, { type: "file" });
    const oneBroken = await computeSourceFingerprint(
      entry,
      dir,
      noRecordedModules,
    );

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
  // MISSING is not 64 hex chars, so no real sha-256 hash can produce the same
  // per-file entry as the sentinel; otherwise a broken-dep file could spoof a
  // healthy fingerprint
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

    const f1 = await computeSourceFingerprint(entry, dir, noRecordedModules);
    const catalog = new FakeCatalog();
    catalog.add({
      source_path: entry,
      type_normalized: "@user/entry",
      kind: "model",
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: f1,
    });

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

    const f2 = await computeSourceFingerprint(entry, dir, noRecordedModules);
    assertNotEquals(f1, f2);
    catalog.removeByRawSourcePath(entry);
    catalog.add({
      source_path: entry,
      type_normalized: "@user/entry",
      kind: "model",
      bundle_path: "",
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: f2,
    });

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

    const broken = await computeSourceFingerprint(
      entry,
      dir,
      noRecordedModules,
    );

    await Deno.remove(dep);
    await Deno.writeTextFile(dep, "export const x = 42;");
    const restored = await computeSourceFingerprint(
      entry,
      dir,
      noRecordedModules,
    );

    assertNotEquals(
      broken,
      restored,
      "Repairing a broken dep must change the fingerprint so the rebundle path fires",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function catalogRow(
  overrides: Partial<ExtensionTypeRow> & { source_path: string },
): ExtensionTypeRow {
  return {
    type_normalized: "",
    kind: "model",
    bundle_path: "",
    version: "",
    description: "",
    extends_type: "",
    source_mtime: "",
    source_fingerprint: "",
    ...overrides,
  };
}

Deno.test("scanCatalogFreshness: removed lists unseen non-failure rows and keeps failure-state rows", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_2490_removed_" });
  try {
    const seen = join(dir, "seen.ts");
    await Deno.writeTextFile(seen, "export const s = 1;");
    const gone = join(dir, "gone.ts");
    const goneLegacy = join(dir, "gone_legacy.ts");
    const buildFailed = join(dir, "build_failed.ts");
    const unreadable = join(dir, "unreadable.ts");
    const orphaned = join(dir, "orphaned.ts");

    const catalog = new FakeCatalog();
    catalog.add(catalogRow({
      source_path: seen,
      type_normalized: "@user/seen",
      source_fingerprint: await computeSourceFingerprint(
        seen,
        dir,
        noRecordedModules,
      ),
    }));
    catalog.add(catalogRow({
      source_path: gone,
      type_normalized: "@user/gone",
      state: "Indexed",
    }));
    catalog.add(catalogRow({
      source_path: goneLegacy,
      type_normalized: "@user/gone-legacy",
    }));
    catalog.add(catalogRow({
      source_path: buildFailed,
      state: "BundleBuildFailed",
    }));
    catalog.add(catalogRow({
      source_path: unreadable,
      state: "EntryPointUnreadable",
    }));
    catalog.add(catalogRow({
      source_path: orphaned,
      state: "OrphanedBundleOnly",
    }));

    const scan = await scanCatalogFreshness({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });

    assertEquals(
      scan.removed.map((r) => r.source_path).sort(),
      [gone, goneLegacy].sort(),
    );
    assertEquals(
      catalog.snapshot().map((r) => r.source_path).sort(),
      [seen, buildFailed, unreadable, orphaned].sort(),
    );
    assertEquals(scan.stale, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanCatalogFreshness: typeless lists seen Indexed primary-kind rows that claim no type and are not stale", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_2490_typeless_" });
  try {
    const names = [
      "indexed.ts",
      "legacy.ts",
      "extension.ts",
      "mismatch.ts",
      "validation_failed.ts",
      "bundled.ts",
      "typed.ts",
    ];
    const paths: Record<string, string> = {};
    const fps: Record<string, string> = {};
    for (const name of names) {
      paths[name] = join(dir, name);
      await Deno.writeTextFile(paths[name], `export const x = "${name}";`);
      fps[name] = await computeSourceFingerprint(
        paths[name],
        dir,
        noRecordedModules,
      );
    }

    const catalog = new FakeCatalog();
    catalog.add(catalogRow({
      source_path: paths["indexed.ts"],
      source_fingerprint: fps["indexed.ts"],
      state: "Indexed",
    }));
    catalog.add(catalogRow({
      source_path: paths["legacy.ts"],
      kind: "vault",
      source_fingerprint: fps["legacy.ts"],
    }));
    catalog.add(catalogRow({
      source_path: paths["extension.ts"],
      kind: "extension",
      source_fingerprint: fps["extension.ts"],
      state: "Indexed",
    }));
    catalog.add(catalogRow({
      source_path: paths["mismatch.ts"],
      source_fingerprint: "does-not-match",
      state: "Indexed",
    }));
    catalog.add(catalogRow({
      source_path: paths["validation_failed.ts"],
      source_fingerprint: fps["validation_failed.ts"],
      state: "ValidationFailed",
    }));
    catalog.add(catalogRow({
      source_path: paths["bundled.ts"],
      source_fingerprint: fps["bundled.ts"],
      state: "Bundled",
    }));
    catalog.add(catalogRow({
      source_path: paths["typed.ts"],
      type_normalized: "@user/typed",
      source_fingerprint: fps["typed.ts"],
      state: "Indexed",
    }));

    const scan = await scanCatalogFreshness({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model", "vault", "extension"],
    });

    assertEquals(
      scan.typeless.map((t) => t.relativePath).sort(),
      ["indexed.ts", "legacy.ts"],
    );
    const indexed = scan.typeless.find((t) => t.relativePath === "indexed.ts");
    assertEquals(indexed?.absolutePath, paths["indexed.ts"]);
    assertEquals(indexed?.baseDir, dir);
    assertEquals(indexed?.row.source_path, paths["indexed.ts"]);
    assertEquals(scan.stale.map((s) => s.relativePath), ["mismatch.ts"]);
    assertEquals(scan.removed, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("collectSeenSources: skips a missing dir", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_2490_seen_" });
  try {
    const file = join(dir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");
    const missing = join(dir, `missing-${crypto.randomUUID()}`);

    const discovered: string[] = [];
    const seen = await collectSeenSources([missing, dir], (d) => {
      discovered.push(d);
      return discoverTsFiles(d);
    });

    assertEquals(discovered, [dir]);
    assertEquals([...seen], [normalizeFreshnessPath(file)]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("normalizeFreshnessPath: folds case and separators only on Windows", () => {
  const input = ["Repo", "Extensions", "Models", "A.ts"].join(SEPARATOR);
  const expected = SEPARATOR === "\\" ? "repo/extensions/models/a.ts" : input;
  assertEquals(normalizeFreshnessPath(input), expected);
});

function recordedModules(
  entries: Record<string, readonly string[]>,
): SourceModuleLookup {
  return { findSourceModules: (path) => entries[path] };
}

Deno.test("computeSourceFingerprint: covers a recorded module outside the boundary dir (swamp-club#3385)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_3385_outside_" });
  try {
    const modelsDir = join(dir, "models");
    await Deno.mkdir(modelsDir);
    await Deno.mkdir(join(dir, "lib"));
    const entry = join(modelsDir, "echo.ts");
    const lib = join(dir, "lib", "msg.ts");
    await Deno.writeTextFile(
      entry,
      'import { MSG } from "../lib/msg.ts";\nexport const m = MSG;',
    );
    await Deno.writeTextFile(lib, 'export const MSG = "v1";');
    const recorded = recordedModules({ [entry]: [entry, lib] });

    const before = await computeSourceFingerprint(entry, modelsDir, recorded);
    const walkedBefore = await computeSourceFingerprint(
      entry,
      modelsDir,
      noRecordedModules,
    );
    await Deno.writeTextFile(lib, 'export const MSG = "v2";');

    assertNotEquals(
      await computeSourceFingerprint(entry, modelsDir, recorded),
      before,
    );
    assertEquals(
      await computeSourceFingerprint(entry, modelsDir, noRecordedModules),
      walkedBefore,
      "the relative-import walk stops at the boundary dir",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: a recorded missing module is stable until it appears (swamp-club#3385)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_3385_missing_" });
  try {
    const entry = join(dir, "a.ts");
    const missing = join(dir, "later.ts");
    await Deno.writeTextFile(entry, "export const a = 1;");
    const recorded = recordedModules({ [entry]: [entry, missing] });

    const first = await computeSourceFingerprint(entry, dir, recorded);
    assertEquals(await computeSourceFingerprint(entry, dir, recorded), first);
    await Deno.writeTextFile(missing, "export const later = 1;");
    assertNotEquals(
      await computeSourceFingerprint(entry, dir, recorded),
      first,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("computeSourceFingerprint: recording the walked modules keeps the walked fingerprint (swamp-club#3385)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_3385_same_" });
  try {
    const entry = join(dir, "a.ts");
    const dep = join(dir, "b.ts");
    await Deno.writeTextFile(entry, 'import { b } from "./b.ts";\n');
    await Deno.writeTextFile(dep, "export const b = 1;");

    assertEquals(
      await computeSourceFingerprint(
        entry,
        dir,
        recordedModules({ [entry]: [entry, dep] }),
      ),
      await computeSourceFingerprint(entry, dir, noRecordedModules),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function scanOneMatchingSource(args: {
  pulled?: boolean;
  recorded?: boolean;
  graphPending?: boolean;
  withoutRepoDir?: boolean;
}): Promise<boolean> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_3385_heal_" });
  try {
    const modelsDir = args.pulled
      ? join(dir, ".swamp", "pulled-extensions", "@test", "ext", "models")
      : join(dir, "extensions", "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const file = join(modelsDir, "a.ts");
    await Deno.writeTextFile(file, "export const a = 1;");

    const catalog = new FakeCatalog();
    if (args.recorded) catalog.sourceModules.set(file, [file]);
    if (args.graphPending) catalog.graphPending.add(file);
    catalog.add(catalogRow({
      source_path: file,
      type_normalized: "@user/a",
      source_fingerprint: await computeSourceFingerprint(
        file,
        modelsDir,
        catalog,
      ),
    }));
    const scan = await scanCatalogFreshness({
      modelsDir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
      repoDir: args.withoutRepoDir ? undefined : dir,
    });
    return scan.stale.length === 1;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("scanCatalogFreshness: a local source with no recorded modules is stale (swamp-club#3385)", async () => {
  assertEquals(await scanOneMatchingSource({}), true);
});

Deno.test("scanCatalogFreshness: a local source with recorded modules and a matching fingerprint is fresh (swamp-club#3385)", async () => {
  assertEquals(await scanOneMatchingSource({ recorded: true }), false);
});

Deno.test("scanCatalogFreshness: a pulled source with no recorded modules is fresh (swamp-club#3385)", async () => {
  assertEquals(await scanOneMatchingSource({ pulled: true }), false);
});

Deno.test("scanCatalogFreshness: without repoDir a source with no recorded modules is fresh (swamp-club#3385)", async () => {
  assertEquals(await scanOneMatchingSource({ withoutRepoDir: true }), false);
});

Deno.test("scanCatalogFreshness: a local source whose recorded modules are graph pending is stale (swamp-club#3487)", async () => {
  assertEquals(
    await scanOneMatchingSource({ recorded: true, graphPending: true }),
    true,
  );
});

Deno.test("scanCatalogFreshness: a pulled source whose recorded modules are graph pending is fresh (swamp-club#3487)", async () => {
  assertEquals(
    await scanOneMatchingSource({
      pulled: true,
      recorded: true,
      graphPending: true,
    }),
    false,
  );
});

Deno.test("scanCatalogFreshness: a removed row's recorded modules are forgotten (swamp-club#3385)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bf_3385_prune_" });
  try {
    const gone = join(dir, "gone.ts");
    const catalog = new FakeCatalog();
    catalog.add(catalogRow({ source_path: gone, type_normalized: "@user/g" }));
    catalog.sourceModules.set(gone, [gone]);

    const scan = await scanCatalogFreshness({
      modelsDir: dir,
      catalog,
      discoverFiles: discoverTsFiles,
      kinds: ["model"],
    });

    assertEquals(scan.removed.map((r) => r.source_path), [gone]);
    assertEquals(catalog.findSourceModules(gone), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
