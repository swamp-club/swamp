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
import fc from "fast-check";
import { matchWorkspacePath } from "./workspace_path.ts";

const arbName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,62}$/);
const arbSegment = fc.stringMatching(/^[A-Za-z0-9._~%-]{0,12}$/);
const arbAbsolutePath = fc.array(arbSegment, { maxLength: 6 }).map((segments) =>
  `/${segments.join("/")}`
);

Deno.test("matchWorkspacePath: any valid name and absolute path round-trip through /w/<name>", () => {
  fc.assert(
    fc.property(arbName, arbAbsolutePath, (name, path) => {
      assertEquals(matchWorkspacePath(`/w/${name}${path}`), {
        kind: "workspace",
        name,
        path,
      });
    }),
  );
});

Deno.test("matchWorkspacePath: any path outside /w/ reaches the root unchanged", () => {
  fc.assert(
    fc.property(arbAbsolutePath, (path) => {
      fc.pre(path !== "/w" && !path.startsWith("/w/"));
      assertEquals(matchWorkspacePath(path), { kind: "root", path });
    }),
  );
});

Deno.test("matchWorkspacePath: no path under /w/ ever reaches the root", () => {
  fc.assert(
    fc.property(arbAbsolutePath, (path) => {
      assertEquals(matchWorkspacePath(`/w${path}`).kind !== "root", true);
    }),
  );
});
