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

import { assertEquals } from "@std/assert";
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";

// --- Pulled extensions: name only, version intentionally empty -------------

Deno.test("deriveExtensionIdentity: pulled extension at /repo/.swamp/pulled-extensions/<name>/models/...", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@scope/foo/models/x.ts",
      "/repo",
    ),
    { name: "@scope/foo", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: pulled scoped extension with multi-segment name", () => {
  // pull.ts joins the per-extension subtree under
  // `.swamp/pulled-extensions/<ref.name>/<type>/`. ref.name can have
  // multiple slashes (e.g. `@hivemq/harvester/kubeconfig`); the helper
  // must consume all segments up to the kind directory.
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      "/repo",
    ),
    { name: "@hivemq/harvester/kubeconfig", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: pulled extension with non-models kind", () => {
  for (
    const kind of [
      "vaults",
      "drivers",
      "datastores",
      "reports",
      "workflows",
      "skills",
    ]
  ) {
    assertEquals(
      deriveExtensionIdentity(
        `/repo/.swamp/pulled-extensions/@scope/foo/${kind}/x.ts`,
        "/repo",
      ),
      { name: "@scope/foo", version: "" },
      `kind=${kind}`,
    );
  }
});

Deno.test("deriveExtensionIdentity: pulled extension with no kind segment returns null", () => {
  // .swamp/pulled-extensions/no-kind-segment/file.ts — corrupt layout
  // (no kind subdir). Migration drops; W1b repository skip-and-DELETEs.
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/no-kind-segment/file.ts",
      "/repo",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: pulled extension with kind at root (zero-length name) returns null", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/models/at-the-root.ts",
      "/repo",
    ),
    null,
  );
});

// --- Local extensions: synthetic @local/<repo-name> at version 0.0.0 -------

Deno.test("deriveExtensionIdentity: local extension under extensions/models/", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/extensions/models/echo.ts",
      "/repo",
    ),
    { name: "@local/repo", version: "0.0.0" },
  );
});

Deno.test("deriveExtensionIdentity: local extension under extensions/vaults/", () => {
  // Same synthetic aggregate for every kind under extensions/.
  assertEquals(
    deriveExtensionIdentity(
      "/path/to/myrepo/extensions/vaults/v.ts",
      "/path/to/myrepo",
    ),
    { name: "@local/myrepo", version: "0.0.0" },
  );
});

Deno.test("deriveExtensionIdentity: local extension uses basename of repoRoot for synthetic name", () => {
  // The architect-pinned synthetic name uses basename(repoRoot).
  // Multi-segment repoRoots collapse to their last segment.
  assertEquals(
    deriveExtensionIdentity(
      "/Users/stack72/code/systeminit/swamp/extensions/models/echo.ts",
      "/Users/stack72/code/systeminit/swamp",
    ),
    { name: "@local/swamp", version: "0.0.0" },
  );
});

// --- Source-mounted extensions ---------------------------------------------
//
// `swamp extension source add <externalDir>` registers an external
// directory as an extension source. Catalog rows for those extensions
// have absolute paths outside `repoRoot`. They roll up into the same
// `@local/<basename(repoRoot)>` aggregate per the design doc:
// "@local/<repo-name> covers every Source under every
// extensions/<kind>/ tree" for the repo, regardless of whether the
// source dir is inside the repo or mounted from outside.

Deno.test("deriveExtensionIdentity: source-mounted extension outside repoRoot resolves to @local/<repo>", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/some/external/dir/extensions/models/foo.ts",
      "/repo",
    ),
    { name: "@local/repo", version: "0.0.0" },
  );
});

Deno.test("deriveExtensionIdentity: source-mounted under /tmp/ resolves to @local/<repo>", () => {
  // The actual layout produced by swamp-uat's source-mount tests
  // (Deno.makeTempDir() places the source dir under /var/folders or
  // /tmp). Pin the contract so a future change can't regress it.
  assertEquals(
    deriveExtensionIdentity(
      "/tmp/swamp-uat-srcmount-srcdir/extensions/models/echo.ts",
      "/private/tmp/myrepo",
    ),
    { name: "@local/myrepo", version: "0.0.0" },
  );
});

Deno.test("deriveExtensionIdentity: source-mounted in a sibling repo's tree still resolves to local for our repo", () => {
  // The catalog opens at /repo/.swamp/_extension_catalog.db; if the
  // user mounted a source at /repo-fork/extensions/models/, those
  // rows belong to OUR repo's @local aggregate.
  assertEquals(
    deriveExtensionIdentity(
      "/repo-fork/extensions/models/x.ts",
      "/repo",
    ),
    { name: "@local/repo", version: "0.0.0" },
  );
});

// --- Path-prefix safety ---------------------------------------------------

Deno.test("deriveExtensionIdentity: path under `extensions-archive/` does NOT match (not the literal `extensions/` segment)", () => {
  // The matcher requires the exact path segment `extensions`;
  // `extensions-archive` is a different segment.
  assertEquals(
    deriveExtensionIdentity(
      "/repo/extensions-archive/old.ts",
      "/repo",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: `/extensions/<unknown-kind>/` does NOT match (kind must be a known kind)", () => {
  // Only the 7 known kind names ('models', 'vaults', 'drivers',
  // 'datastores', 'reports', 'workflows', 'skills') count. A
  // hypothetical `extensions/widgets/` would not match.
  assertEquals(
    deriveExtensionIdentity(
      "/repo/extensions/widgets/foo.ts",
      "/repo",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: empty source path returns null", () => {
  assertEquals(deriveExtensionIdentity("", "/repo"), null);
});

// --- Regression: relative repoRoot "." (swamp-club#273) ---------------------

Deno.test("deriveExtensionIdentity: relative repoRoot '.' fails to match absolute pulled paths", () => {
  // Bug 3 regression pin: when repoRoot is ".", the pulled prefix
  // "./.swamp/pulled-extensions/" does not match absolute source paths.
  // The fix is in resolveRepoDir (always returns absolute); this test
  // pins the behavior so a future regression is caught.
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@scope/foo/models/x.ts",
      ".",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: absolute repoRoot correctly matches pulled paths", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@scope/foo/models/x.ts",
      "/repo",
    ),
    { name: "@scope/foo", version: "" },
  );
});

// --- Windows canonical form (lowercase + forward slashes) ------------------

Deno.test("deriveExtensionIdentity: Windows canonical form (lowercase + forward slashes) for pulled", () => {
  // The migration canonicalizes source_path before backfill (sub-step 4
  // of W1a step 2); this test pins that we accept the canonical form.
  assertEquals(
    deriveExtensionIdentity(
      "c:/users/foo/repo/.swamp/pulled-extensions/@scope/foo/models/x.ts",
      "c:/users/foo/repo",
    ),
    { name: "@scope/foo", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: Windows canonical form for local", () => {
  assertEquals(
    deriveExtensionIdentity(
      "c:/users/foo/myrepo/extensions/models/echo.ts",
      "c:/users/foo/myrepo",
    ),
    { name: "@local/myrepo", version: "0.0.0" },
  );
});
