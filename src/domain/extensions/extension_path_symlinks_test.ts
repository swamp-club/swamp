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
import { join, resolve } from "@std/path";
import {
  firstSymlinkedComponent,
  pathComponentsToCheck,
} from "./extension_path_symlinks.ts";

const repo = resolve("/work/repo");

Deno.test("pathComponentsToCheck: lists each component below the root, outermost first, ending with the file", () => {
  assertEquals(
    pathComponentsToCheck(join(repo, "extensions", "models", "m.ts"), [repo]),
    [
      join(repo, "extensions"),
      join(repo, "extensions", "models"),
      join(repo, "extensions", "models", "m.ts"),
    ],
  );
});

Deno.test("pathComponentsToCheck: measures from the outermost root that contains the path", () => {
  const extRoot = join(repo, "ext");
  assertEquals(
    pathComponentsToCheck(join(extRoot, "m.ts"), [extRoot, repo]),
    [extRoot, join(extRoot, "m.ts")],
  );
});

Deno.test("pathComponentsToCheck: a path under no root is checked by its own last component", () => {
  const outside = resolve("/elsewhere/lib/x.ts");
  assertEquals(pathComponentsToCheck(outside, [repo]), [outside]);
});

Deno.test("pathComponentsToCheck: a root itself is not checked against itself", () => {
  assertEquals(pathComponentsToCheck(repo, [repo]), [repo]);
});

Deno.test("firstSymlinkedComponent: finds a symlinked directory between the root and the file", async () => {
  const link = join(repo, "extensions", "models", "foo");
  const asked: string[] = [];
  const found = await firstSymlinkedComponent(
    join(link, "foo.ts"),
    [repo],
    (c) => {
      asked.push(c);
      return Promise.resolve(c === link);
    },
  );
  assertEquals(found, link);
  // It stops at the first symlink: nothing below it is asked about.
  assertEquals(asked.includes(join(link, "foo.ts")), false);
});

Deno.test("firstSymlinkedComponent: never asks about the root or anything above it", async () => {
  const asked: string[] = [];
  const found = await firstSymlinkedComponent(
    join(repo, "m.ts"),
    [repo],
    (c) => {
      asked.push(c);
      return Promise.resolve(false);
    },
  );
  assertEquals(found, undefined);
  assertEquals(asked, [join(repo, "m.ts")]);
});
