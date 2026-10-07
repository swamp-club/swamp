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

// Properties of displayPath (swamp-club#3017): the printed path always opens
// the same file from cwd, and it climbs out of cwd only when the two share an
// ancestor below the filesystem root.

import { assert, assertEquals } from "@std/assert";
import { isAbsolute, join, resolve, SEPARATOR } from "@std/path";
import fc from "fast-check";
import { displayPath } from "./display_path.ts";

const ROOT = SEPARATOR === "\\" ? "C:\\" : "/";
const arbSegments = fc.array(
  fc.constantFrom("home", "tmp", "a", "b", "work", "x.ts", "my dir"),
  { minLength: 0, maxLength: 4 },
);
const arbPath = arbSegments.map((segments) => join(ROOT, ...segments));

Deno.test("displayPath: resolving the printed path from cwd yields the file", () => {
  fc.assert(
    fc.property(arbPath, arbPath, (file, cwd) => {
      assertEquals(resolve(cwd, displayPath(file, cwd)), resolve(file));
    }),
  );
});

Deno.test("displayPath: the printed path is absolute exactly when only the root is shared", () => {
  fc.assert(
    fc.property(arbSegments, arbSegments, (fileSegs, cwdSegs) => {
      const printed = displayPath(
        join(ROOT, ...fileSegs),
        join(ROOT, ...cwdSegs),
      );
      const onlyRootShared = cwdSegs.length > 0 &&
        (fileSegs.length === 0 || fileSegs[0] !== cwdSegs[0]);
      assert(isAbsolute(printed) === onlyRootShared, printed);
    }),
  );
});
