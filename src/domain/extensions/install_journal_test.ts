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
import { assertStringIncludes } from "@std/assert/string-includes";
import { join, relative, resolve } from "@std/path";
import {
  bundleStagingDirName,
  type InstallJournal,
  type InstallJournalBounds,
  isExtensionName,
  isStagingEntryName,
  isStagingId,
  nestedEntryRelDirs,
  type ObservedInstall,
  type ObservedPath,
  type ObservedRoot,
  parseInstallJournal,
  planRecovery,
  type RecoveryRename,
  rootDiscardPath,
  rootStagingPaths,
  STAGED_MANIFEST_FILE,
  STAGING_DIR_NAME,
} from "./install_journal.ts";

const REPO = resolve("/repo");
const PULLED = join(REPO, ".swamp", "pulled-extensions");
const BUNDLES = join(REPO, ".swamp", "bundles");
const NAME = "@acme/thing";
const EXT_ROOT = join(PULLED, "@acme", "thing");
const BUNDLE_ROOT = join(BUNDLES, "abcd1234");
const LOCKFILE = join(
  REPO,
  "extensions",
  "models",
  "upstream_extensions.json",
);
const STAGING_ID = "0b0e1f0c-1111-4222-8333-944445555666";
const OWNER_ID = "5d7c3e1a-aaaa-4bbb-8ccc-9dddeeeeffff";

const bounds: InstallJournalBounds = {
  repoDir: REPO,
  pulledRoot: PULLED,
  allowedLockfilePaths: [LOCKFILE],
  expectedLivePaths: (name) => ({
    extensionRoot: join(PULLED, ...name.split("/")),
    bundleRoots: name === NAME ? [BUNDLE_ROOT] : [],
  }),
};

function makeJournal(
  overrides: {
    phase?: "staged" | "swapped";
    extLiveExisted?: boolean;
    bundle?: { liveExisted: boolean; hasNew: boolean } | null;
  } = {},
): InstallJournal {
  const ext = rootStagingPaths({
    pulledRoot: PULLED,
    stagingId: STAGING_ID,
    role: "extension",
    live: EXT_ROOT,
    index: 0,
  });
  const roots: InstallJournal["roots"] = [{
    index: 0,
    role: "extension",
    live: EXT_ROOT,
    stagingDir: ext.stagingDir,
    old: ext.old,
    new: ext.new,
    liveExisted: overrides.extLiveExisted ?? true,
    hasNew: true,
  }];
  const bundle = overrides.bundle === undefined
    ? { liveExisted: true, hasNew: true }
    : overrides.bundle;
  if (bundle) {
    const b = rootStagingPaths({
      pulledRoot: PULLED,
      stagingId: STAGING_ID,
      role: "bundle",
      live: BUNDLE_ROOT,
      index: 1,
    });
    roots.push({
      index: 1,
      role: "bundle",
      live: BUNDLE_ROOT,
      stagingDir: b.stagingDir,
      old: b.old,
      new: b.new,
      ...bundle,
    });
  }
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    stagingId: STAGING_ID,
    repoDir: REPO,
    extensionName: NAME,
    phase: overrides.phase ?? "staged",
    lockfilePath: LOCKFILE,
    newChecksum: "new-sum",
    oldManifestDigest: "old-manifest",
    newManifestDigest: "new-manifest",
    roots,
    manifest: {
      staged: join(ext.stagingDir, STAGED_MANIFEST_FILE),
      live: join(EXT_ROOT, "manifest.yaml"),
    },
    nestedRoots: [],
  };
}

function rootState(
  old: ObservedPath,
  newState: ObservedPath,
  live: ObservedPath,
  discard: ObservedPath = "absent",
): ObservedRoot {
  return { old, new: newState, live, discard };
}

function observe(
  roots: Record<number, ObservedRoot>,
  manifest: {
    staged?: ObservedPath;
    live?: ObservedPath;
    digest?: string | null;
  } = {},
): ObservedInstall {
  return {
    roots: new Map(Object.entries(roots).map(([k, v]) => [Number(k), v])),
    stagedManifest: manifest.staged ?? "absent",
    liveManifest: manifest.live ?? "file",
    liveManifestDigest: manifest.digest === undefined
      ? "new-manifest"
      : manifest.digest,
    unsafeDir: null,
  };
}

// ---- staging names ----

Deno.test("isStagingEntryName: matches the pulled-root dir and bundle siblings", () => {
  assertEquals(isStagingEntryName(STAGING_DIR_NAME), true);
  assertEquals(isStagingEntryName(bundleStagingDirName(STAGING_ID)), true);
  assertEquals(isStagingEntryName("@acme"), false);
  assertEquals(isStagingEntryName("abcd1234"), false);
  assertEquals(isStagingEntryName(".swamp-stagingx"), false);
});

Deno.test("isStagingId: accepts uuids only", () => {
  assertEquals(isStagingId(STAGING_ID), true);
  assertEquals(isStagingId("not-a-uuid"), false);
  assertEquals(isStagingId(`${STAGING_ID}/..`), false);
});

Deno.test("rootStagingPaths: keeps each root's staging next to its live dir", () => {
  const ext = rootStagingPaths({
    pulledRoot: PULLED,
    stagingId: STAGING_ID,
    role: "extension",
    live: EXT_ROOT,
    index: 0,
  });
  assertEquals(ext.stagingDir, join(PULLED, STAGING_DIR_NAME, STAGING_ID));
  assertEquals(ext.old, join(ext.stagingDir, "old", "0"));
  const bundle = rootStagingPaths({
    pulledRoot: PULLED,
    stagingId: STAGING_ID,
    role: "bundle",
    live: BUNDLE_ROOT,
    index: 2,
  });
  assertEquals(
    bundle.stagingDir,
    join(BUNDLES, bundleStagingDirName(STAGING_ID)),
  );
  assertEquals(bundle.new, join(bundle.stagingDir, "new", "2"));
  assertEquals(bundle.discard, join(bundle.stagingDir, "discard", "2"));
});

// ---- parseInstallJournal ----

Deno.test("parseInstallJournal: accepts a journal built from the layout", () => {
  const journal = makeJournal();
  const result = parseInstallJournal(
    JSON.parse(JSON.stringify(journal)),
    bounds,
    STAGING_ID,
  );
  assertEquals(result, { ok: true, journal });
});

function assertRejected(raw: unknown, expected: string, dir = STAGING_ID) {
  const result = parseInstallJournal(raw, bounds, dir);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.reason, expected);
}

Deno.test("parseInstallJournal: rejects a journal that fails the schema", () => {
  assertRejected({ ...makeJournal(), phase: "moving" }, "schema");
  assertRejected({ ...makeJournal(), extra: 1 }, "schema");
  assertRejected({ ...makeJournal(), extensionName: "@a/../b" }, "schema");
  assertRejected("not an object", "schema");
});

Deno.test("parseInstallJournal: rejects a stagingId that is not its dir", () => {
  assertRejected(
    makeJournal(),
    "does not match its dir",
    "11111111-1111-4111-8111-111111111111",
  );
});

Deno.test("parseInstallJournal: rejects a lockfile path outside the allow-list", () => {
  assertRejected(
    { ...makeJournal(), lockfilePath: "/etc/upstream_extensions.json" },
    "not a lockfile of this repository",
  );
});

Deno.test("parseInstallJournal: rejects a live path not derived from the name", () => {
  const journal = makeJournal();
  journal.roots[0] = { ...journal.roots[0], live: join("/repo", "src") };
  assertRejected(journal, "extension root");

  const bundleJournal = makeJournal();
  bundleJournal.roots[1] = {
    ...bundleJournal.roots[1],
    live: join("/repo", ".swamp", "bundles", "ffffffff"),
  };
  assertRejected(bundleJournal, "not a bundle dir");
});

Deno.test("parseInstallJournal: rejects staging paths off the layout", () => {
  const journal = makeJournal();
  journal.roots[0] = { ...journal.roots[0], old: join("/repo", "elsewhere") };
  assertRejected(journal, "do not match its layout");

  const manifest = makeJournal();
  manifest.manifest = { ...manifest.manifest, live: join("/repo", "x.yaml") };
  assertRejected(manifest, "manifest paths");
});

/** `journal` as an install in a repo at `from` wrote it. */
function writtenUnder(journal: InstallJournal, from: string): InstallJournal {
  const move = (path: string) => join(from, relative(REPO, path));
  return {
    ...journal,
    repoDir: from,
    lockfilePath: move(journal.lockfilePath),
    roots: journal.roots.map((root) => ({
      ...root,
      live: move(root.live),
      stagingDir: move(root.stagingDir),
      old: move(root.old),
      new: move(root.new),
    })),
    manifest: {
      staged: move(journal.manifest.staged),
      live: move(journal.manifest.live),
    },
  };
}

const MOVED_FROM = resolve("/old", "place");

Deno.test("parseInstallJournal: rebases a journal written before the repo moved", () => {
  for (const phase of ["staged", "swapped"] as const) {
    const current = makeJournal({ phase });
    const result = parseInstallJournal(
      writtenUnder(current, MOVED_FROM),
      bounds,
      STAGING_ID,
    );
    assertEquals(result, { ok: true, journal: current });
  }
});

Deno.test("parseInstallJournal: keeps a lockfile path outside the recorded repo dir", () => {
  const outside = resolve("/etc", "upstream_extensions.json");
  const journal = {
    ...writtenUnder(makeJournal(), MOVED_FROM),
    lockfilePath: outside,
  };
  assertRejected(journal, "not a lockfile of this repository");

  const result = parseInstallJournal(
    journal,
    { ...bounds, allowedLockfilePaths: [LOCKFILE, outside] },
    STAGING_ID,
  );
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.journal.lockfilePath, outside);
});

Deno.test("parseInstallJournal: rejects a repo dir that is not absolute", () => {
  assertRejected(
    { ...makeJournal(), repoDir: "repo" },
    "is not an absolute path",
  );
});

Deno.test("parseInstallJournal: the rebase accepts only paths on the current layout", () => {
  // The filesystem root as the recorded repo dir moves every path one
  // level too deep.
  assertRejected(
    { ...makeJournal(), repoDir: resolve("/") },
    "not a lockfile of this repository",
  );

  // A root outside the recorded repo dir is not rebased.
  const outside = writtenUnder(makeJournal(), MOVED_FROM);
  outside.roots[0] = {
    ...outside.roots[0],
    live: resolve("/elsewhere", "@acme", "thing"),
  };
  assertRejected(outside, "extension root");

  // A staging path off the layout stays off it after the rebase.
  const offLayout = writtenUnder(makeJournal(), MOVED_FROM);
  offLayout.roots[0] = {
    ...offLayout.roots[0],
    old: join(MOVED_FROM, "elsewhere"),
  };
  assertRejected(offLayout, "do not match its layout");
});

Deno.test("isExtensionName: accepts scoped names and nothing that could leave the pulled root", () => {
  assertEquals(isExtensionName("@acme/thing"), true);
  assertEquals(isExtensionName("@acme/thing/child"), true);
  for (const name of ["acme/thing", "@acme", "@acme/../thing", "../x", ""]) {
    assertEquals(isExtensionName(name), false, name);
  }
});

Deno.test("parseInstallJournal: rejects repeated roots and a missing extension root", () => {
  const repeated = makeJournal();
  repeated.roots[1] = { ...repeated.roots[1], index: 0 };
  assertRejected(repeated, "repeats");

  const noExt = makeJournal();
  noExt.roots = noExt.roots.slice(1);
  assertRejected(noExt, "exactly one extension root");
});

Deno.test("parseInstallJournal: accepts a bundle root with nothing before or from the archive (swamp-club#2724)", () => {
  // Journaled so a roll-back also removes bundles the catalog save's
  // loaders write into it after the swap.
  const empty = makeJournal({ bundle: { liveExisted: false, hasNew: false } });
  assertEquals(parseInstallJournal(empty, bounds, STAGING_ID).ok, true);

  // The extension root always has a new version.
  const noNewExt = makeJournal();
  noNewExt.roots[0] = { ...noNewExt.roots[0], hasNew: false };
  assertRejected(noNewExt, "extension root has no new version");
});

Deno.test("planRecovery: a bundle root with nothing before or from the archive is discarded on roll-back, kept rolling forward (swamp-club#2724)", () => {
  const journal = makeJournal({
    phase: "swapped",
    bundle: { liveExisted: false, hasNew: false },
  });
  const bundle = journal.roots[1];

  // A loader wrote bundles into it after the swap: roll-back discards them.
  const loaderWrote = planRecovery(
    journal,
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("absent", "absent", "dir"),
    }),
    "old-sum",
  );
  assertEquals(loaderWrote.direction, "back");
  if (loaderWrote.direction === "back") {
    assertEquals(
      loaderWrote.renames.filter((r) => r.from === bundle.live),
      [{ from: bundle.live, to: rootDiscardPath(bundle) }],
    );
  }

  // Nothing was written: no rename for the bundle root.
  const untouched = planRecovery(
    journal,
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("absent", "absent", "absent"),
    }),
    "old-sum",
  );
  assertEquals(untouched.direction, "back");
  if (untouched.direction === "back") {
    assertEquals(untouched.renames.some((r) => r.from === bundle.live), false);
  }

  // Rolling forward, the cache dir's presence does not matter.
  for (const live of ["dir", "absent"] as const) {
    assertEquals(
      planRecovery(
        journal,
        observe({
          0: rootState("dir", "absent", "dir"),
          1: rootState("absent", "absent", live),
        }),
        "new-sum",
      ),
      { direction: "forward" },
    );
  }
});

Deno.test("parseInstallJournal: accepts a symlinked extension root only", () => {
  const ext = makeJournal();
  ext.roots[0] = { ...ext.roots[0], liveIsLink: true };
  assertEquals(parseInstallJournal(ext, bounds, STAGING_ID).ok, true);

  const bundle = makeJournal();
  bundle.roots[1] = { ...bundle.roots[1], liveIsLink: true };
  assertRejected(bundle, "cannot have been a symlink");

  const absent = makeJournal({ extLiveExisted: false });
  absent.roots[0] = { ...absent.roots[0], liveIsLink: true };
  assertRejected(absent, "cannot have been a symlink");
});

Deno.test("parseInstallJournal: rejects a nested root that is not an entry path", () => {
  const journal = makeJournal();
  journal.nestedRoots = [{ relDir: "../escape", strategy: "copied" }];
  assertRejected(journal, "nested root");
});

// ---- planRecovery: rolling back ----

interface BackRow {
  name: string;
  liveExisted: boolean;
  hasNew: boolean;
  state: ObservedRoot;
  expected: "none" | "old-to-live" | "swap-back" | "discard-live" | "leave";
}

const BACK_ROWS: BackRow[] = [
  {
    name: "never moved",
    liveExisted: true,
    hasNew: true,
    state: rootState("absent", "dir", "dir"),
    expected: "none",
  },
  {
    name: "crash inside begin, before new/ existed",
    liveExisted: true,
    hasNew: true,
    state: rootState("absent", "absent", "dir"),
    expected: "none",
  },
  {
    name: "already restored by an earlier recovery",
    liveExisted: true,
    hasNew: true,
    state: rootState("absent", "absent", "dir", "dir"),
    expected: "none",
  },
  {
    name: "phase 1 done, phase 2 not",
    liveExisted: true,
    hasNew: true,
    state: rootState("dir", "dir", "absent"),
    expected: "old-to-live",
  },
  {
    name: "earlier recovery moved new aside, old still out",
    liveExisted: true,
    hasNew: true,
    state: rootState("dir", "absent", "absent", "dir"),
    expected: "old-to-live",
  },
  {
    name: "fully swapped",
    liveExisted: true,
    hasNew: true,
    state: rootState("dir", "absent", "dir"),
    expected: "swap-back",
  },
  {
    name: "a live dir recreated next to the moved-aside original",
    liveExisted: true,
    hasNew: true,
    state: rootState("dir", "dir", "dir"),
    expected: "swap-back",
  },
  {
    name: "removed root never moved",
    liveExisted: true,
    hasNew: false,
    state: rootState("absent", "absent", "dir"),
    expected: "none",
  },
  {
    name: "removed root moved aside",
    liveExisted: true,
    hasNew: false,
    state: rootState("dir", "absent", "absent"),
    expected: "old-to-live",
  },
  {
    name: "new root never moved in",
    liveExisted: false,
    hasNew: true,
    state: rootState("absent", "dir", "absent"),
    expected: "none",
  },
  {
    name: "crash while deleting staging after a roll-back",
    liveExisted: false,
    hasNew: true,
    state: rootState("absent", "absent", "absent"),
    expected: "none",
  },
  {
    name: "new root moved in",
    liveExisted: false,
    hasNew: true,
    state: rootState("absent", "absent", "dir"),
    expected: "discard-live",
  },
  {
    name: "a live dir created after the install began",
    liveExisted: false,
    hasNew: true,
    state: rootState("absent", "dir", "dir"),
    expected: "discard-live",
  },
  {
    name: "new root already discarded",
    liveExisted: false,
    hasNew: true,
    state: rootState("absent", "absent", "absent", "dir"),
    expected: "none",
  },
  {
    name: "the original is gone",
    liveExisted: true,
    hasNew: true,
    state: rootState("absent", "absent", "absent"),
    expected: "leave",
  },
  {
    name: "discard occupied while live must move aside",
    liveExisted: true,
    hasNew: true,
    state: rootState("dir", "absent", "dir", "dir"),
    expected: "leave",
  },
  {
    name: "old present for a root that did not exist",
    liveExisted: false,
    hasNew: true,
    state: rootState("dir", "dir", "absent"),
    expected: "leave",
  },
  {
    name: "a symlink at the live path",
    liveExisted: true,
    hasNew: true,
    state: rootState("absent", "dir", "symlink"),
    expected: "leave",
  },
  {
    name: "a file where the old dir belongs",
    liveExisted: true,
    hasNew: true,
    state: rootState("file", "dir", "absent"),
    expected: "leave",
  },
];

for (const row of BACK_ROWS) {
  Deno.test(`planRecovery: rolling back, ${row.name}`, () => {
    const journal = makeJournal({
      bundle: { liveExisted: row.liveExisted, hasNew: row.hasNew },
    });
    const bundle = journal.roots[1];
    const plan = planRecovery(
      journal,
      observe({
        0: rootState("absent", "dir", "dir"),
        1: row.state,
      }),
      null,
    );
    const discard = join(bundle.stagingDir, "discard", "1");
    switch (row.expected) {
      case "leave":
        assertEquals(plan.direction, "leave");
        return;
      case "none":
        assertEquals(plan, { direction: "back", renames: [] });
        return;
      case "old-to-live":
        assertEquals(plan, {
          direction: "back",
          renames: [{ from: bundle.old, to: bundle.live }],
        });
        return;
      case "swap-back":
        assertEquals(plan, {
          direction: "back",
          renames: [
            { from: bundle.live, to: discard },
            { from: bundle.old, to: bundle.live },
          ],
        });
        return;
      case "discard-live":
        assertEquals(plan, {
          direction: "back",
          renames: [{ from: bundle.live, to: discard }],
        });
        return;
    }
  });
}

Deno.test("planRecovery: rolls back a swapped journal whose lockfile entry is old", () => {
  const journal = makeJournal({ phase: "swapped" });
  const plan = planRecovery(
    journal,
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("dir", "absent", "dir"),
    }),
    "old-sum",
  );
  assertEquals(plan.direction, "back");
  if (plan.direction === "back") assertEquals(plan.renames.length, 4);
});

Deno.test("planRecovery: rolls back a staged journal even when the lockfile matches", () => {
  const plan = planRecovery(
    makeJournal({ phase: "staged" }),
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("dir", "absent", "dir"),
    }),
    "new-sum",
  );
  assertEquals(plan.direction, "back");
});

Deno.test("planRecovery: leaves a journal whose staging has an unsafe dir", () => {
  const plan = planRecovery(
    makeJournal(),
    {
      ...observe({
        0: rootState("dir", "absent", "dir"),
        1: rootState("dir", "absent", "dir"),
      }),
      unsafeDir: "/repo/.swamp/bundles/.swamp-staging-x",
    },
    null,
  );
  assertEquals(plan.direction, "leave");
});

Deno.test("planRecovery: leaves a journal with an unobserved root", () => {
  const plan = planRecovery(
    makeJournal(),
    observe({ 0: rootState("absent", "dir", "dir") }),
    null,
  );
  assertEquals(plan.direction, "leave");
});

// ---- planRecovery: a symlinked extension root ----

interface LinkRow {
  name: string;
  state: ObservedRoot;
  expected: "none" | "old-to-live" | "swap-back" | "leave";
}

const LINK_ROWS: LinkRow[] = [
  {
    name: "the link never moved",
    state: rootState("absent", "dir", "symlink"),
    expected: "none",
  },
  {
    name: "the link moved aside, nothing live",
    state: rootState("symlink", "dir", "absent"),
    expected: "old-to-live",
  },
  {
    name: "the link moved aside, the new dir live",
    state: rootState("symlink", "absent", "dir"),
    expected: "swap-back",
  },
  {
    name: "a directory where the link was, nothing moved aside",
    state: rootState("absent", "dir", "dir"),
    expected: "leave",
  },
  {
    name: "a directory where the moved-aside link belongs",
    state: rootState("dir", "absent", "dir"),
    expected: "leave",
  },
];

for (const row of LINK_ROWS) {
  Deno.test(`planRecovery: a symlinked extension root, ${row.name}`, () => {
    const journal = makeJournal({ bundle: null });
    journal.roots[0] = { ...journal.roots[0], liveIsLink: true };
    const ext = journal.roots[0];
    const plan = planRecovery(journal, observe({ 0: row.state }), null);
    const restore: RecoveryRename = {
      from: ext.old,
      to: ext.live,
      kind: "symlink",
    };
    switch (row.expected) {
      case "leave":
        assertEquals(plan.direction, "leave");
        return;
      case "none":
        assertEquals(plan, { direction: "back", renames: [] });
        return;
      case "old-to-live":
        assertEquals(plan, { direction: "back", renames: [restore] });
        return;
      case "swap-back":
        assertEquals(plan, {
          direction: "back",
          renames: [
            { from: ext.live, to: join(ext.stagingDir, "discard", "0") },
            restore,
          ],
        });
        return;
    }
  });
}

Deno.test("planRecovery: rolls forward past a moved-aside link", () => {
  const journal = makeJournal({ phase: "swapped", bundle: null });
  journal.roots[0] = { ...journal.roots[0], liveIsLink: true };
  const plan = planRecovery(
    journal,
    observe({ 0: rootState("symlink", "absent", "dir") }),
    "new-sum",
  );
  assertEquals(plan, { direction: "forward" });
});

// ---- planRecovery: rolling forward ----

Deno.test("planRecovery: rolls forward a swapped journal whose lockfile entry landed", () => {
  const plan = planRecovery(
    makeJournal({ phase: "swapped" }),
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("dir", "absent", "dir"),
    }),
    "new-sum",
  );
  assertEquals(plan, { direction: "forward" });
});

Deno.test("planRecovery: rolls forward after a commit that deleted some old dirs", () => {
  const plan = planRecovery(
    makeJournal({ phase: "swapped" }),
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("absent", "absent", "dir"),
    }),
    "new-sum",
  );
  assertEquals(plan, { direction: "forward" });
});

Deno.test("planRecovery: rolls forward a removed bundle root that is gone", () => {
  const plan = planRecovery(
    makeJournal({
      phase: "swapped",
      bundle: { liveExisted: true, hasNew: false },
    }),
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("dir", "absent", "absent"),
    }),
    "new-sum",
  );
  assertEquals(plan, { direction: "forward" });
});

Deno.test("planRecovery: rolls forward past a bundle cache dir a loader rebuilt or evicted", () => {
  // Rebuilt: the new version shipped no bundles, yet the dir is back.
  assertEquals(
    planRecovery(
      makeJournal({
        phase: "swapped",
        bundle: { liveExisted: true, hasNew: false },
      }),
      observe({
        0: rootState("dir", "absent", "dir"),
        1: rootState("dir", "absent", "dir"),
      }),
      "new-sum",
    ),
    { direction: "forward" },
  );
  // Evicted: the new bundles went in, then a layout eviction removed them.
  assertEquals(
    planRecovery(
      makeJournal({ phase: "swapped" }),
      observe({
        0: rootState("dir", "absent", "dir"),
        1: rootState("dir", "absent", "absent"),
      }),
      "new-sum",
    ),
    { direction: "forward" },
  );
});

Deno.test("planRecovery: leaves a forward journal whose extension root is missing", () => {
  const plan = planRecovery(
    makeJournal({ phase: "swapped" }),
    observe({
      0: rootState("dir", "absent", "absent"),
      1: rootState("dir", "absent", "dir"),
    }),
    "new-sum",
  );
  assertEquals(plan.direction, "leave");
});

Deno.test("planRecovery: leaves a forward journal whose new root is still staged", () => {
  const plan = planRecovery(
    makeJournal({ phase: "swapped" }),
    observe({
      0: rootState("dir", "absent", "dir"),
      1: rootState("dir", "dir", "absent"),
    }),
    "new-sum",
  );
  assertEquals(plan.direction, "leave");
});

Deno.test("planRecovery: leaves a forward journal whose live manifest is not its own", () => {
  const roots = {
    0: rootState("dir", "absent", "dir"),
    1: rootState("dir", "absent", "dir"),
  };
  const journal = makeJournal({ phase: "swapped" });
  assertEquals(
    planRecovery(journal, observe(roots, { digest: "other" }), "new-sum")
      .direction,
    "leave",
  );
  assertEquals(
    planRecovery(journal, observe(roots, { staged: "file" }), "new-sum")
      .direction,
    "leave",
  );
  assertEquals(
    planRecovery(
      journal,
      observe(roots, { live: "absent", digest: null }),
      "new-sum",
    ).direction,
    "leave",
  );
});

// ---- nestedEntryRelDirs ----

Deno.test("nestedEntryRelDirs: returns child entries relative to the parent", () => {
  assertEquals(
    nestedEntryRelDirs("@a/b", ["@a/b", "@a/b/c", "@a/b/d/e", "@a/bc", "@x/y"]),
    ["c", "d/e"],
  );
  assertEquals(nestedEntryRelDirs("@a/b", []), []);
});
