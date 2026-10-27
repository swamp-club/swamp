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
import {
  installedPackageVersion,
  mergePackageVersions,
  packageVersionsFromDenoInfo,
} from "./package_versions.ts";

Deno.test("packageVersionsFromDenoInfo: reads npm and jsr redirects, subpaths and type imports", () => {
  const versions = packageVersionsFromDenoInfo({
    redirects: {
      "npm:ms@^2/package.json": "npm:/ms@2.1.3/package.json",
      "jsr:@std/assert@^1/assert":
        "https://jsr.io/@std/assert/1.0.19/assert.ts",
      "jsr:@vec/lib@^1": "http://127.0.0.1:4507/@vec/lib/1.0.0/mod.ts",
      "npm:@types/ms@^2": "npm:/@types/ms@2.1.0",
      "https://deno.land/x/a/mod.ts": "https://deno.land/x/a@1.0.0/mod.ts",
    },
    modules: [],
  });
  assertEquals(versions, {
    "npm:ms@^2/package.json": { specifier: "npm:ms@2.1.3" },
    "jsr:@std/assert@^1/assert": { specifier: "jsr:@std/assert@1.0.19" },
    "jsr:@vec/lib@^1": { specifier: "jsr:@vec/lib@1.0.0" },
    "npm:@types/ms@^2": { specifier: "npm:@types/ms@2.1.0" },
  });
});

Deno.test("packageVersionsFromDenoInfo: an npm dependency's npmPackage answers when no redirect does", () => {
  assertEquals(
    packageVersionsFromDenoInfo({
      modules: [{
        specifier: "file:///m.ts",
        dependencies: [{
          specifier: "npm:is-number@^7",
          code: { specifier: "npm:is-number@^7" },
          npmPackage: "is-number@7.0.0",
        }],
      }],
    }),
    { "npm:is-number@^7": { specifier: "npm:is-number@7.0.0" } },
  );
});

Deno.test("packageVersionsFromDenoInfo: a target naming another package or no plain version is ignored", () => {
  assertEquals(
    packageVersionsFromDenoInfo({
      redirects: {
        "npm:ms@^2": "npm:/other@2.1.3",
        "npm:x@^1": "npm:/x@1.0.0-",
        "jsr:@a/b@^1": "https://jsr.io/@a/c/1.0.0/mod.ts",
      },
    }),
    {},
  );
  assertEquals(packageVersionsFromDenoInfo(null), {});
});

Deno.test("installedPackageVersion: pins an npm import to the installed copy of the same package", () => {
  assertEquals(installedPackageVersion("npm:ms@^2", "ms", "2.1.0"), {
    specifier: "npm:ms@2.1.0",
    installed: true,
  });
  assertEquals(
    installedPackageVersion("npm:ms@^2", "other", "2.1.0"),
    undefined,
  );
  assertEquals(
    installedPackageVersion("jsr:@a/b@1", "@a/b", "1.0.0"),
    undefined,
  );
  assertEquals(installedPackageVersion("npm:ms@^2", "ms", "latest"), undefined);
});

Deno.test("mergePackageVersions: the first graph's answer for a specifier wins", () => {
  assertEquals(
    mergePackageVersions([
      { "npm:ms@^2": { specifier: "npm:ms@2.1.3" } },
      undefined,
      {
        "npm:ms@^2": { specifier: "npm:ms@2.0.0" },
        "npm:a@1": { specifier: "npm:a@1.0.0" },
      },
    ]),
    {
      "npm:ms@^2": { specifier: "npm:ms@2.1.3" },
      "npm:a@1": { specifier: "npm:a@1.0.0" },
    },
  );
});
