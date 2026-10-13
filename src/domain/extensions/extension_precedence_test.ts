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

import { assert, assertEquals } from "@std/assert";
import {
  compareExtensionPrecedence,
  contributorTier,
  type ExtensionContributor,
  isPulledExtensionPath,
} from "./extension_precedence.ts";

const REPO = "/work/repo";

Deno.test("isPulledExtensionPath: classifies both pulled roots as pulled", () => {
  assert(
    isPulledExtensionPath(
      `${REPO}/.swamp/pulled-extensions/@acme/x/models/a.ts`,
      REPO,
    ),
  );
  assert(
    isPulledExtensionPath(
      `${REPO}/.swamp/config/pulled-extensions/@acme/x/models/a.ts`,
      REPO,
    ),
  );
});

Deno.test("isPulledExtensionPath: local and source-mounted paths are not pulled", () => {
  assert(!isPulledExtensionPath(`${REPO}/extensions/models/a.ts`, REPO));
  assert(!isPulledExtensionPath("/elsewhere/extensions/models/a.ts", REPO));
  // A sibling directory that only shares the prefix text is not pulled.
  assert(
    !isPulledExtensionPath(
      `${REPO}/.swamp/pulled-extensions-archive/a.ts`,
      REPO,
    ),
  );
  // Another repo's pulled root is not this repo's.
  assert(
    !isPulledExtensionPath(
      "/work/other/.swamp/pulled-extensions/@acme/x/models/a.ts",
      REPO,
    ),
  );
});

Deno.test("isPulledExtensionPath: tolerates a trailing slash on the repo root", () => {
  assert(
    isPulledExtensionPath(
      `${REPO}/.swamp/pulled-extensions/@acme/x/models/a.ts`,
      `${REPO}/`,
    ),
  );
});

Deno.test("compareExtensionPrecedence: non-pulled beats pulled regardless of path", () => {
  const local: ExtensionContributor = {
    sourcePath: `${REPO}/zz/extensions/models/z.ts`,
    pulled: false,
  };
  const pulled: ExtensionContributor = {
    sourcePath: `${REPO}/.swamp/pulled-extensions/@aaa/models/a.ts`,
    pulled: true,
  };
  assert(compareExtensionPrecedence(local, pulled) < 0);
  assert(compareExtensionPrecedence(pulled, local) > 0);
});

Deno.test("compareExtensionPrecedence: within a tier the smaller path wins", () => {
  const aa: ExtensionContributor = {
    sourcePath: `${REPO}/extensions/models/aa_ext.ts`,
    pulled: false,
  };
  const zz: ExtensionContributor = {
    sourcePath: `${REPO}/extensions/models/zz_ext.ts`,
    pulled: false,
  };
  assert(compareExtensionPrecedence(aa, zz) < 0);
  assert(compareExtensionPrecedence(zz, aa) > 0);
  assertEquals(compareExtensionPrecedence(aa, { ...aa }), 0);
});

Deno.test("compareExtensionPrecedence: local beats source-mounted beats pulled, whatever the paths (swamp-club#2563)", () => {
  const local: ExtensionContributor = {
    sourcePath: "/zz/repo/extensions/models/z.ts",
    pulled: false,
  };
  const mounted: ExtensionContributor = {
    sourcePath: "/aa/shared/extensions/models/a.ts",
    pulled: false,
    mountIndex: 0,
  };
  const pulled: ExtensionContributor = {
    sourcePath: "/00/repo/.swamp/pulled-extensions/@a/models/a.ts",
    pulled: true,
  };
  assert(compareExtensionPrecedence(local, mounted) < 0);
  assert(compareExtensionPrecedence(mounted, local) > 0);
  assert(compareExtensionPrecedence(mounted, pulled) < 0);
  assertEquals(contributorTier(local), "local");
  assertEquals(contributorTier(mounted), "source-mounted");
  assertEquals(contributorTier(pulled), "pulled");
});

Deno.test("compareExtensionPrecedence: an earlier mount beats a later one, whatever the paths", () => {
  const first: ExtensionContributor = {
    sourcePath: "/zz/extensions/models/x.ts",
    pulled: false,
    mountIndex: 0,
  };
  const second: ExtensionContributor = {
    sourcePath: "/aa/extensions/models/x.ts",
    pulled: false,
    mountIndex: 1,
  };
  assert(compareExtensionPrecedence(first, second) < 0);
  assert(compareExtensionPrecedence(second, first) > 0);
});
