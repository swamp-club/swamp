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
// the same file from cwd, and it is relative exactly when the file is under
// cwd, or under a pushed-content root and sharing an ancestor below the
// filesystem root with cwd.

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
    fc.property(arbPath, arbPath, arbPath, (file, cwd, root) => {
      assertEquals(
        resolve(cwd, displayPath(file, cwd, [root])),
        resolve(file),
      );
    }),
  );
});

/** Whether `segs` starts with every segment of `prefix`. */
function startsWith(segs: string[], prefix: string[]): boolean {
  return prefix.every((s, i) => segs[i] === s);
}

Deno.test("displayPath: the printed path is relative exactly when under cwd, or under a root and sharing more than the filesystem root", () => {
  fc.assert(
    fc.property(
      arbSegments,
      arbSegments,
      arbSegments,
      (fileSegs, cwdSegs, rootSegs) => {
        const printed = displayPath(
          join(ROOT, ...fileSegs),
          join(ROOT, ...cwdSegs),
          [join(ROOT, ...rootSegs)],
        );
        const underCwd = startsWith(fileSegs, cwdSegs);
        const sharesTop = fileSegs.length > 0 && cwdSegs.length > 0 &&
          fileSegs[0] === cwdSegs[0];
        const underRoot = startsWith(fileSegs, rootSegs);
        const relativeExpected = underCwd || (underRoot && sharesTop);
        assert(isAbsolute(printed) !== relativeExpected, printed);
      },
    ),
  );
});
