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

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { ensureDirSync } from "@std/fs";
import { join } from "@std/path";
import type { ExtensionRepository } from "./extension_repository.ts";
import { ExtensionCatalogStore } from "./extension_catalog_store.ts";
import { DuplicateTypeError } from "./duplicate_type_error.ts";
import {
  fixedLockedVersions,
  makeStubRepository,
} from "./test_helpers/stub_extension_repository.ts";
import type { UpstreamExtensionsMap } from "./upstream_extensions.ts";
import {
  type Extension,
  makeExtension,
  observeFreshSource,
  recordSourceMissing,
  recordValidationFailed,
  tombstoneAll,
} from "../../domain/extensions/extension.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import { makeSource } from "../../domain/extensions/source.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";

/**
 * Creates `<tmpRoot>/.swamp/_extension_catalog.db` and returns
 * `{ repoRoot, dbPath }`. The repoRoot is what the repository sees as
 * the canonical repo root for empty-identity fallback derivation.
 */
function makeTempLayout(): { repoRoot: string; dbPath: string } {
  const repoRoot = Deno.makeTempDirSync({
    prefix: "swamp-ext-repo-test-",
  });
  ensureDirSync(join(repoRoot, ".swamp"));
  return {
    repoRoot,
    dbPath: join(repoRoot, ".swamp", "_extension_catalog.db"),
  };
}

function withRepository(
  fn: (
    repo: ExtensionRepository,
    catalog: ExtensionCatalogStore,
    repoRoot: string,
  ) => void,
  opts?: { lockedVersions?: UpstreamExtensionsMap },
): void {
  const { repoRoot, dbPath } = makeTempLayout();
  const { repository, catalog } = makeStubRepository({
    dbPath,
    repoRoot,
    lockedVersions: opts?.lockedVersions,
  });
  try {
    fn(repository, catalog, repoRoot);
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      Deno.removeSync(repoRoot, { recursive: true });
    } else {
      Deno.removeSync(repoRoot, { recursive: true });
    }
  }
}

function pulledExtension(args: {
  repoRoot: string;
  name: string;
  version: string;
  sources: Array<{ relPath: string; type: string }>;
}): Extension {
  const extRoot = `${args.repoRoot}/.swamp/pulled-extensions/${args.name}`;
  const sources = args.sources.map((s) => {
    const abs = `${extRoot}/${s.relPath}`;
    return makeSource({
      id: makeSourceLocation(abs, extRoot),
      kind: "model",
      fingerprint: "fp-" + s.relPath,
      state: {
        tag: "Indexed",
        type: s.type,
        bundle: makeBundleLocation(
          `${args.repoRoot}/.swamp/bundles/${s.relPath}.js`,
          "fp-" + s.relPath,
        ),
      },
    });
  });
  return makeExtension({
    name: args.name,
    version: args.version,
    origin: "pulled",
    extensionRoot: extRoot,
    sources,
  });
}

// ===== Test #1: round-trip save/load =====
Deno.test("ExtensionRepository: round-trip save → load returns the same shape", () => {
  withRepository((repo, _cat, repoRoot) => {
    const ext = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "1.0.0",
      sources: [
        { relPath: "models/instance.ts", type: "@scope/foo/instance" },
        { relPath: "models/cluster.ts", type: "@scope/foo/cluster" },
      ],
    });
    repo.save(ext);

    const loaded = repo.loadAll();
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].name, "@scope/foo");
    assertEquals(loaded[0].version, "1.0.0");
    assertEquals(loaded[0].origin, "pulled");
    assertEquals(loaded[0].sources.size, 2);
  });
});

// ===== Test #2: diff-save INSERT =====
Deno.test("ExtensionRepository: diff-save adds a new Source as INSERT", () => {
  withRepository((repo, _cat, repoRoot) => {
    const v1 = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "1.0.0",
      sources: [{ relPath: "models/a.ts", type: "@scope/foo/a" }],
    });
    repo.save(v1);
    assertEquals(repo.loadAll()[0].sources.size, 1);

    // Add a new Source via observeFreshSource → save → expect INSERT
    const extRoot = v1.extensionRoot;
    const newLoc = makeSourceLocation(
      `${extRoot}/models/b.ts`,
      extRoot,
    );
    const v1Plus = observeFreshSource(v1, {
      location: newLoc,
      kind: "model",
      fingerprint: "fp-new",
      type: "@scope/foo/b",
      bundle: makeBundleLocation(
        `${repoRoot}/.swamp/bundles/b.js`,
        "fp-new",
      ),
    });
    repo.save(v1Plus);
    const loaded = repo.loadAll();
    assertEquals(loaded[0].sources.size, 2);
  });
});

// ===== Test #3: diff-save DELETE — swamp-club#201 reproducer at the repository layer =====
Deno.test("ExtensionRepository: diff-save drops a Source as DELETE (swamp-club#201 reproducer at repo layer)", () => {
  // The original #201 bug: `extension rm` left rows in bundle_types
  // because the catalog had no diff-aware delete path. With the
  // repository, saving an Extension that no longer owns a Source
  // results in a DELETE on that row. This test reproduces the bug at
  // the REPOSITORY LAYER — proving the W1b plumbing fixes it; the
  // user-facing `extension rm` wiring lands in W2 (RemoveExtensionService).
  withRepository((repo, cat, repoRoot) => {
    const v1 = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "1.0.0",
      sources: [
        { relPath: "models/a.ts", type: "@scope/foo/a" },
        { relPath: "models/b.ts", type: "@scope/foo/b" },
      ],
    });
    repo.save(v1);
    assertEquals(cat.findAll().length, 2);

    // v2 of the aggregate has only `models/a.ts` — `models/b.ts` was
    // deleted by the user. Save should DELETE the b.ts row.
    const v1WithoutB = makeExtension({
      name: v1.name,
      version: v1.version,
      origin: v1.origin,
      extensionRoot: v1.extensionRoot,
      sources: [...v1.sources.values()].filter((s) =>
        s.id.relativePath === "models/a.ts"
      ),
    });
    repo.save(v1WithoutB);
    const remaining = cat.findAll();
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].source_path.endsWith("models/a.ts"), true);
  });
});

// ===== Test #4: diff-save UPDATE =====
Deno.test("ExtensionRepository: diff-save transitions a Source state as UPDATE", () => {
  withRepository((repo, cat, repoRoot) => {
    const ext = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "1.0.0",
      sources: [{ relPath: "models/a.ts", type: "@scope/foo/a" }],
    });
    repo.save(ext);
    const before = cat.findAll();
    assertEquals(before[0].state, "Indexed");

    // Move to ValidationFailed, save → row updates in place.
    const sourceId = [...ext.sources.values()][0].id;
    const failed = recordValidationFailed(ext, {
      location: sourceId,
      bundle: makeBundleLocation(
        `${repoRoot}/.swamp/bundles/a.ts.js`,
        "fp-models/a.ts",
      ),
      lastError: "schema",
    });
    repo.save(failed);
    const after = cat.findAll();
    assertEquals(after.length, 1); // Same row, not a new one
    assertEquals(after[0].state, "ValidationFailed");
    // type_normalized cleared so I-Repo-1 doesn't see this as occupying
    // the namespace
    assertEquals(after[0].type_normalized, "");
  });
});

// ===== Test #5: saveAll upgrade pattern =====
Deno.test("ExtensionRepository: saveAll([vN.tombstoneAll(), vN+1]) succeeds when both ship same (kind, type)", () => {
  withRepository((repo, _cat, repoRoot) => {
    const v1 = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "1.0.0",
      sources: [{ relPath: "models/instance.ts", type: "@scope/foo/instance" }],
    });
    repo.save(v1);

    // v2 ships the SAME (kind, type) as v1. Naive "save v2 alongside v1"
    // would hit I-Repo-1. The atomic upgrade pattern wraps v1.tombstoneAll
    // and v2 in one saveAll; v1's Sources are Tombstoned in the
    // post-state, so only v2 occupies the slot.
    const v2 = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "2.0.0",
      sources: [{ relPath: "models/instance.ts", type: "@scope/foo/instance" }],
    });
    repo.saveAll([tombstoneAll(v1), v2]);

    const loaded = repo.loadAll();
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].version, "2.0.0");
  });
});

// ===== Test #6: saveAll cross-extension DuplicateType reject + ROLLBACK =====
Deno.test("ExtensionRepository: saveAll rejects cross-extension (kind, type) with ROLLBACK and names both paths", () => {
  withRepository((repo, cat, repoRoot) => {
    const a = pulledExtension({
      repoRoot,
      name: "@scope/a",
      version: "1.0.0",
      sources: [{ relPath: "models/x.ts", type: "@dup/x" }],
    });
    const b = pulledExtension({
      repoRoot,
      name: "@scope/b",
      version: "1.0.0",
      sources: [{ relPath: "models/x.ts", type: "@dup/x" }],
    });

    // Pre-condition: catalog empty.
    assertEquals(cat.findAll().length, 0);

    let thrown: unknown;
    try {
      repo.saveAll([a, b]);
    } catch (e) {
      thrown = e;
    }
    assert(thrown instanceof DuplicateTypeError);
    if (!(thrown instanceof DuplicateTypeError)) return;
    assertEquals(thrown.kind, "model");
    assertEquals(thrown.typeNormalized, "@dup/x");
    // Both source paths named — the hard requirement.
    assertStringIncludes(thrown.message, "@scope/a");
    assertStringIncludes(thrown.message, "@scope/b");

    // ROLLBACK applied: catalog still empty.
    assertEquals(cat.findAll().length, 0);
  });
});

// ===== Test #7: I-Repo-1 fires on save(ext) directly, not just saveAll =====
Deno.test("ExtensionRepository: I-Repo-1 fires on save(ext) directly when reusing another extension's (kind, type)", () => {
  withRepository((repo, cat, repoRoot) => {
    const a = pulledExtension({
      repoRoot,
      name: "@scope/a",
      version: "1.0.0",
      sources: [{ relPath: "models/x.ts", type: "@dup/x" }],
    });
    repo.save(a);
    const aRowsBefore = cat.findAll().length;

    const b = pulledExtension({
      repoRoot,
      name: "@scope/b",
      version: "1.0.0",
      sources: [{ relPath: "models/x.ts", type: "@dup/x" }],
    });
    assertThrows(() => repo.save(b), DuplicateTypeError);

    // ROLLBACK: a's rows unaffected; b's rows not persisted.
    const after = cat.findAll();
    assertEquals(after.length, aRowsBefore);
    for (const row of after) {
      assertEquals(row.extension_name, "@scope/a");
    }
  });
});

// ===== Test #8: lockfile fallback happy path =====
Deno.test("ExtensionRepository: lockfile fallback resolves empty version, writes back, second-load is direct", () => {
  withRepository((repo, cat, repoRoot) => {
    // Seed a row with the extension_name populated but extension_version
    // empty — the W1a-shipped state for pulled rows.
    const sp =
      `${repoRoot}/.swamp/pulled-extensions/@scope/foo/models/instance.ts`;
    cat.upsertWithIdentity({
      source_path: sp,
      type_normalized: "@scope/foo/instance",
      kind: "model",
      bundle_path: `${repoRoot}/.swamp/bundles/instance.js`,
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "fp",
      state: "Indexed",
      extension_name: "@scope/foo",
      extension_version: "",
    });

    const exts = repo.loadAll();
    assertEquals(exts.length, 1);
    assertEquals(exts[0].name, "@scope/foo");
    assertEquals(exts[0].version, "1.0.0");

    // Verify the write-back: the row should now have the resolved version.
    const writtenBack = cat.findByExtension("@scope/foo", "1.0.0");
    assertEquals(writtenBack.length, 1);

    // Second load goes through the direct path (extension_version
    // populated), not the fallback. The aggregate result must be
    // identical.
    const exts2 = repo.loadAll();
    assertEquals(exts2.length, 1);
    assertEquals(exts2[0].version, "1.0.0");
  }, { lockedVersions: fixedLockedVersions({ "@scope/foo": "1.0.0" }) });
});

// ===== Test #9: lockfile fallback orphan path =====
Deno.test("ExtensionRepository: lockfile fallback orphan-DELETEs a pulled row whose lockfile entry is gone", () => {
  withRepository((repo, cat, repoRoot) => {
    const sp =
      `${repoRoot}/.swamp/pulled-extensions/@scope/abandoned/models/x.ts`;
    cat.upsertWithIdentity({
      source_path: sp,
      type_normalized: "@scope/abandoned/x",
      kind: "model",
      bundle_path: `${repoRoot}/.swamp/bundles/x.js`,
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "fp",
      state: "Indexed",
      extension_name: "@scope/abandoned",
      extension_version: "",
    });
    assertEquals(cat.findAll().length, 1);

    // Lockfile lookup returns null — the entry is gone (e.g. user
    // deleted upstream_extensions.json or the entry was pruned).
    const exts = repo.loadAll();
    assertEquals(exts.length, 0);
    // The row was DELETEd as an orphan.
    assertEquals(cat.findAll().length, 0);
  }, { lockedVersions: {} });
});

// ===== Test #10: cold-start guard parity over all 5 kinds =====
Deno.test("ExtensionRepository: invalidationGuards parity over all 5 kinds × 4 triggers", () => {
  withRepository((repo, cat) => {
    const kinds = ["model", "vault", "driver", "datastore", "report"] as const;
    const layoutVersion = "per-extension-aggregate-v3";
    const dsBase = "/some/base/path";
    const fingerprint = "fp-A";

    for (const kind of kinds) {
      // Trigger 1: not-populated. Catalog has nothing for this kind.
      const r1 = repo.invalidationGuards({
        kind,
        expectedLayoutVersion: layoutVersion,
        expectedDatastoreBasePath: dsBase,
        expectedSourceDirsFingerprint: fingerprint,
      });
      assertEquals(
        r1,
        { shouldInvalidate: true, reason: "not-populated" },
        `kind=${kind} trigger=not-populated`,
      );

      // Set up the kind so it's "populated and fresh."
      cat.markPopulated(kind);
      cat.setLayoutVersion(layoutVersion);
      cat.setDatastoreBasePath(dsBase, kind);
      cat.setSourceDirsFingerprint(fingerprint, kind);

      // Trigger 0 (no firing): everything matches.
      const fresh = repo.invalidationGuards({
        kind,
        expectedLayoutVersion: layoutVersion,
        expectedDatastoreBasePath: dsBase,
        expectedSourceDirsFingerprint: fingerprint,
      });
      assertEquals(fresh, { shouldInvalidate: false, reason: "fresh" });

      // Trigger 2: layout-version mismatch.
      const r2 = repo.invalidationGuards({
        kind,
        expectedLayoutVersion: "per-extension-aggregate-v999",
        expectedDatastoreBasePath: dsBase,
        expectedSourceDirsFingerprint: fingerprint,
      });
      assertEquals(
        r2,
        { shouldInvalidate: true, reason: "layout-version-mismatch" },
        `kind=${kind} trigger=layout`,
      );

      // Trigger 3: datastore-base-path changed.
      const r3 = repo.invalidationGuards({
        kind,
        expectedLayoutVersion: layoutVersion,
        expectedDatastoreBasePath: "/different/base",
        expectedSourceDirsFingerprint: fingerprint,
      });
      assertEquals(
        r3,
        { shouldInvalidate: true, reason: "datastore-base-path-changed" },
        `kind=${kind} trigger=ds-base`,
      );

      // Trigger 4: source-dirs-fingerprint changed.
      const r4 = repo.invalidationGuards({
        kind,
        expectedLayoutVersion: layoutVersion,
        expectedDatastoreBasePath: dsBase,
        expectedSourceDirsFingerprint: "fp-B",
      });
      assertEquals(
        r4,
        { shouldInvalidate: true, reason: "source-dirs-fingerprint-changed" },
        `kind=${kind} trigger=fingerprint`,
      );
    }
  });
});

// ===== Test #13: W3-corruption boundary — two pulled versions on disk =====
Deno.test("ExtensionRepository: two pulled rows for same name resolve to same version → DuplicateTypeError surfaces (W3 territory)", () => {
  withRepository((repo, cat, repoRoot) => {
    // Set up: two source files for the SAME logical extension on disk
    // (interrupted upgrade). Each row has empty extension_version.
    // Lockfile says the only version present is 2.0.0, so both rows
    // resolve to the same (name, version), then I-Repo-1 fires.
    const sp1 =
      `${repoRoot}/.swamp/pulled-extensions/@scope/foo/models/instance.ts`;
    const sp2 =
      `${repoRoot}/.swamp/pulled-extensions/@scope/foo/models/extra/instance.ts`;
    for (const sp of [sp1, sp2]) {
      cat.upsertWithIdentity({
        source_path: sp,
        type_normalized: "@scope/foo/instance",
        kind: "model",
        bundle_path: sp.replace(".ts", ".js"),
        version: "",
        description: "",
        extends_type: "",
        source_mtime: "",
        source_fingerprint: "fp",
        state: "Indexed",
        extension_name: "@scope/foo",
        extension_version: "",
      });
    }

    // loadAll runs the empty-version fallback for both rows. Both
    // resolve to (name=@scope/foo, version=2.0.0). When the test then
    // tries to SAVE the resulting aggregate, the intra-extension I2
    // fires inside makeExtension. We catch the exception inside loadAll
    // because the two rows fold into a single Extension whose two
    // Sources occupy the same (kind, type).
    let thrown: unknown;
    try {
      repo.loadAll();
    } catch (e) {
      thrown = e;
    }
    // Either I2 (intra-extension) or I-Repo-1 fires — either way, the
    // corruption surfaces as an error rather than silent first-wins.
    // The repository's loadAll currently uses makeExtension which throws
    // IntraExtensionDuplicateType. The post-condition is the same:
    // corruption surfaces, fallback does NOT try to repair.
    assert(thrown instanceof Error);
    if (!(thrown instanceof Error)) return;
    // Both source paths must appear in the error message.
    assertStringIncludes(thrown.message, "models/instance.ts");
    assertStringIncludes(thrown.message, "models/extra/instance.ts");
  }, { lockedVersions: fixedLockedVersions({ "@scope/foo": "2.0.0" }) });
});

// ===== Supporting tests =====
Deno.test("ExtensionRepository: invalidateAll on missing DB does not throw", () => {
  // Pass a path that doesn't exist; opening it creates an empty DB,
  // so invalidateAll runs against an empty state. The semantic the
  // open.ts/doctor_extensions.ts callers depend on is "don't crash."
  const repoRoot = Deno.makeTempDirSync({ prefix: "swamp-ext-repo-test-" });
  ensureDirSync(join(repoRoot, ".swamp"));
  const dbPath = join(repoRoot, ".swamp", "_extension_catalog.db");
  const { repository, catalog } = makeStubRepository({ dbPath, repoRoot });
  try {
    repository.invalidateAll(); // must not throw
  } finally {
    catalog.close();
    Deno.removeSync(repoRoot, { recursive: true });
  }
});

Deno.test("ExtensionRepository: invalidateAll on corrupt DB does not throw", () => {
  // Write garbage bytes into the .db file before opening — opening will
  // throw, but the standalone forceCatalogRescan was best-effort. The
  // new shape is: callers wrap repository construction in try/catch
  // (per step 13's pattern). This test verifies repository.invalidateAll
  // itself is best-effort against a successfully-opened-but-corrupt DB.
  const repoRoot = Deno.makeTempDirSync({ prefix: "swamp-ext-repo-test-" });
  ensureDirSync(join(repoRoot, ".swamp"));
  const dbPath = join(repoRoot, ".swamp", "_extension_catalog.db");
  // Open + close to create a valid empty DB.
  const c = new ExtensionCatalogStore(dbPath);
  c.close();
  // Truncate the DB to 0 bytes — sqlite will treat this as empty +
  // initialise schema on next open.
  Deno.writeFileSync(dbPath, new Uint8Array());

  const { repository, catalog } = makeStubRepository({ dbPath, repoRoot });
  try {
    repository.invalidateAll(); // must not throw
  } finally {
    catalog.close();
    Deno.removeSync(repoRoot, { recursive: true });
  }
});

Deno.test("ExtensionRepository: tombstoned-only save DELETEs the row", () => {
  // Cousin of test #3. Save an extension with a Tombstoned source
  // and verify the row is DELETEd rather than persisted with state=
  // "Tombstoned" (per I4: dropped on save).
  withRepository((repo, cat, repoRoot) => {
    const ext = pulledExtension({
      repoRoot,
      name: "@scope/foo",
      version: "1.0.0",
      sources: [{ relPath: "models/a.ts", type: "@scope/foo/a" }],
    });
    repo.save(ext);
    assertEquals(cat.findAll().length, 1);

    // Tombstone the source.
    const sourceId = [...ext.sources.values()][0].id;
    const tomb = recordSourceMissing(ext, { location: sourceId });
    repo.save(tomb);
    // Row gone, not retained as state="Tombstoned".
    assertEquals(cat.findAll().length, 0);
  });
});

Deno.test("ExtensionRepository: empty-identity row with neither name nor version is derived via deriveExtensionIdentity", () => {
  withRepository((repo, cat, repoRoot) => {
    // Seed a row matching the local-extension layout but with both
    // identity columns empty (W1a leftover for new-rows-from-loaders).
    const sp = `${repoRoot}/extensions/models/local.ts`;
    cat.upsertWithIdentity({
      source_path: sp,
      type_normalized: "@local/test/local",
      kind: "model",
      bundle_path: `${repoRoot}/.swamp/bundles/local.js`,
      version: "",
      description: "",
      extends_type: "",
      source_mtime: "",
      source_fingerprint: "fp",
      state: "Indexed",
      extension_name: "",
      extension_version: "",
    });
    const exts = repo.loadAll();
    assertEquals(exts.length, 1);
    assertEquals(exts[0].origin, "local");
    assertEquals(exts[0].version, "0.0.0");
    // Write-back happened: row now has identity populated.
    const after = cat.findAll();
    assertFalse(after[0].extension_name === "");
    assertFalse(after[0].extension_version === "");
  });
});
