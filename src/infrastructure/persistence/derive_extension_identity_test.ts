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
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";

Deno.test("deriveExtensionIdentity: pulled extension at /repo/.swamp/pulled-extensions/<name>/models/...", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@scope/foo/models/x.ts",
      "/repo",
    ),
    { name: "@scope/foo", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: pulled extension under the managed .swamp/config/pulled-extensions root", () => {
  // managedConfig repos extract to .swamp/config/pulled-extensions/; rows there
  // must derive the same identity as the legacy root, or extension rm never
  // finds them
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/config/pulled-extensions/@swamp/aws/cur/models/report_definition.ts",
      "/repo",
    ),
    { name: "@swamp/aws/cur", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: managed root honours knownNames", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/config/pulled-extensions/@org/foo/webhooks/models/hook.ts",
      "/repo",
      ["@org/foo/webhooks"],
    ),
    { name: "@org/foo/webhooks", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: managed root wins over the local extensions/<kind> rule", () => {
  // An extension named `@org/extensions` puts an `extensions/models`
  // segment pair in the path; the pulled rule must match first.
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/config/pulled-extensions/@org/extensions/models/x.ts",
      "/repo",
    ),
    { name: "@org/extensions", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: managed root with no kind segment returns null", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/config/pulled-extensions/no-kind/file.ts",
      "/repo",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: Windows canonical form for the managed root", () => {
  assertEquals(
    deriveExtensionIdentity(
      "c:/users/foo/repo/.swamp/config/pulled-extensions/@scope/foo/models/x.ts",
      "c:/users/foo/repo",
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
      "datastores",
      "reports",
      "webhooks",
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

Deno.test("deriveExtensionIdentity: scoped name whose second segment is a kind directory", () => {
  for (const kind of ["models", "webhooks", "reports"]) {
    assertEquals(
      deriveExtensionIdentity(
        `/repo/.swamp/pulled-extensions/@org/${kind}/models/hook.ts`,
        "/repo",
      ),
      { name: `@org/${kind}`, version: "" },
      `kind=${kind}`,
    );
  }
});

Deno.test("deriveExtensionIdentity: known names resolve names containing a kind segment", () => {
  const sp = "/repo/.swamp/pulled-extensions/@org/foo/webhooks/models/x.ts";
  assertEquals(
    deriveExtensionIdentity(sp, "/repo", ["@org/foo", "@org/foo/webhooks"]),
    { name: "@org/foo/webhooks", version: "" },
  );
  assertEquals(
    deriveExtensionIdentity(sp, "/repo", ["@org/foobar"]),
    { name: "@org/foo", version: "" },
  );
});

Deno.test("deriveExtensionIdentity: pulled extension with no kind segment returns null", () => {
  // corrupt layout with no kind subdir: no identity can be derived, so the
  // result is null
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
  assertEquals(
    deriveExtensionIdentity(
      "/path/to/myrepo/extensions/vaults/v.ts",
      "/path/to/myrepo",
    ),
    { name: "@local/myrepo", version: "0.0.0" },
  );
});

Deno.test("deriveExtensionIdentity: local extension uses basename of repoRoot for synthetic name", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/Users/stack72/code/systeminit/swamp/extensions/models/echo.ts",
      "/Users/stack72/code/systeminit/swamp",
    ),
    { name: "@local/swamp", version: "0.0.0" },
  );
});

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
  // Deno.makeTempDir places a source dir under /var/folders or /tmp, outside
  // repoRoot, as swamp-uat's source-mount tests do
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

Deno.test("deriveExtensionIdentity: path under `extensions-archive/` does NOT match (not the literal `extensions/` segment)", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/extensions-archive/old.ts",
      "/repo",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: `/extensions/<unknown-kind>/` does NOT match (kind must be a known kind)", () => {
  // Only the 6 known kind names ('models', 'vaults',
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

Deno.test("deriveExtensionIdentity: relative repoRoot '.' fails to match absolute pulled paths", () => {
  // repoRoot '.' must not match absolute pulled paths; resolveRepoDir always
  // returns an absolute path, and this pins that behavior
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

Deno.test("deriveExtensionIdentity: Windows canonical form (lowercase + forward slashes) for pulled", () => {
  // the migration canonicalizes source_path before backfill, so the canonical
  // form must be accepted
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

Deno.test("deriveExtensionIdentity: Windows backslash paths return null (callers must canonicalize)", () => {
  assertEquals(
    deriveExtensionIdentity(
      "C:\\Users\\foo\\myrepo\\extensions\\models\\echo.ts",
      "C:\\Users\\foo\\myrepo",
    ),
    null,
  );
});

Deno.test("deriveExtensionIdentity: local extension under extensions/behaviors/", () => {
  assertEquals(
    deriveExtensionIdentity("/repo/extensions/behaviors/echo.ts", "/repo"),
    { name: "@local/repo", version: "0.0.0" },
  );
  assertEquals(
    deriveExtensionIdentity(
      "/external/src/extensions/behaviors/aws/ec2.ts",
      "/repo",
    ),
    { name: "@local/repo", version: "0.0.0" },
  );
});

Deno.test("deriveExtensionIdentity: a pulled name containing behaviors is not split there", () => {
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@org/behaviors/tools/models/x.ts",
      "/repo",
    ),
    { name: "@org/behaviors/tools", version: "" },
  );
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/behaviors/models/x.ts",
      "/repo",
    ),
    { name: "behaviors", version: "" },
  );
  // a pulled tree has no behaviors kind directory, so without a kind segment
  // the layout is unrecognised
  assertEquals(
    deriveExtensionIdentity(
      "/repo/.swamp/pulled-extensions/@org/x/behaviors/y.ts",
      "/repo",
    ),
    null,
  );
});
