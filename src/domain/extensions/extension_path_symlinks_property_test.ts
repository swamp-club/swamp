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
import fc from "fast-check";
import { dirname, join, resolve, SEPARATOR } from "@std/path";
import { pathComponentsToCheck } from "./extension_path_symlinks.ts";

const segment = fc.constantFrom(
  "extensions",
  "models",
  ".claude",
  "skills",
  "lib",
  "m.ts",
  "a b",
  "..",
  ".",
);
const relPath = fc.array(segment, { minLength: 1, maxLength: 6 });
const base = resolve("/work");

Deno.test("pathComponentsToCheck: every component is under the chosen root and ends at the file", () => {
  fc.assert(
    fc.property(relPath, relPath, (rootSegs, fileSegs) => {
      const root = resolve(base, ...rootSegs);
      const file = resolve(root, ...fileSegs);
      const components = pathComponentsToCheck(file, [root]);
      assertEquals(components[components.length - 1], file);
      if (file === root || !file.startsWith(root)) return;
      for (let i = 1; i < components.length; i++) {
        assertEquals(dirname(components[i]), components[i - 1]);
      }
      assert(!components.includes(root));
    }),
  );
});

Deno.test("pathComponentsToCheck: adding an inner root never adds components to check", () => {
  fc.assert(
    fc.property(relPath, relPath, (innerSegs, fileSegs) => {
      const outer = base;
      const inner = resolve(outer, ...innerSegs);
      const file = resolve(inner, ...fileSegs);
      // An inner root lies strictly under the outer one.
      fc.pre(inner.startsWith(outer + SEPARATOR));
      const outerOnly = pathComponentsToCheck(file, [outer]);
      const both = pathComponentsToCheck(file, [inner, outer]);
      assertEquals(both, outerOnly);
    }),
  );
});

Deno.test("pathComponentsToCheck: a path under no root yields only itself", () => {
  fc.assert(
    fc.property(relPath, (segs) => {
      const file = join(
        resolve("/elsewhere"),
        ...segs.filter((s) => s !== ".." && s !== "."),
      );
      assertEquals(pathComponentsToCheck(file, [base]), [resolve(file)]);
    }),
  );
});
