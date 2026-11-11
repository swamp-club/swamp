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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../domain/errors.ts";
import { checkReloadedGrantSources } from "./serve_grant_reload.ts";

Deno.test("checkReloadedGrantSources: a grants-dir that is the repository grants directory is no external source", () => {
  assertEquals(
    checkReloadedGrantSources({
      grantsDir: { status: "same-as-repo", configured: "grants" },
    }),
    {},
  );
});

Deno.test("checkReloadedGrantSources: a missing or unreadable grants-dir, or a file in it that fails, refuses the reload", () => {
  assertThrows(
    () =>
      checkReloadedGrantSources({
        grantsDir: { status: "missing", path: "/g", cause: new Error("x") },
      }),
    UserError,
    "External grants directory not found: /g",
  );
  assertThrows(
    () =>
      checkReloadedGrantSources({
        grantsDir: { status: "unreadable", path: "/g", cause: "EACCES" },
      }),
    UserError,
    "Failed to read external grants directory /g",
  );
  assertThrows(
    () =>
      checkReloadedGrantSources({
        grantsDir: {
          status: "loaded",
          path: "/g",
          files: [{
            name: "a.yaml",
            sourceName: "grants-dir/a.yaml",
            path: "/g/a.yaml",
            result: null,
            readError: "EIO",
          }],
        },
      }),
    UserError,
    "Failed to read grants file /g/a.yaml",
  );
});

Deno.test("checkReloadedGrantSources: loaded sources name their paths", () => {
  assertEquals(
    checkReloadedGrantSources({
      grantsFile: {
        status: "loaded",
        path: "/f.yaml",
        file: { path: "/f.yaml", result: null },
      },
      grantsDir: { status: "loaded", path: "/g", files: [] },
    }),
    { externalGrantsFile: "/f.yaml", externalGrantsDir: "/g" },
  );
});
