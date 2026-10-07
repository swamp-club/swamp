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
import { join, resolve, SEPARATOR } from "@std/path";
import { displayPath } from "./display_path.ts";

const ROOT = SEPARATOR === "\\" ? "C:\\" : "/";
const CWD = join(ROOT, "home", "author", "work");

Deno.test("displayPath: a file under cwd prints relative to it", () => {
  assertEquals(
    displayPath(join(CWD, "extensions", "models", "a.ts"), CWD),
    join("extensions", "models", "a.ts"),
  );
});

Deno.test("displayPath: a sibling directory prints with a leading ..", () => {
  assertEquals(
    displayPath(join(ROOT, "home", "author", "other", "manifest.yaml"), CWD),
    join("..", "other", "manifest.yaml"),
  );
});

Deno.test("displayPath: a file sharing only the root with cwd prints absolute", () => {
  const file = join(ROOT, "tmp", "swamp-extension-review", "r.json");
  assertEquals(displayPath(file, CWD), file);
});

Deno.test("displayPath: cwd itself prints as .", () => {
  assertEquals(displayPath(CWD, CWD), ".");
});

Deno.test("displayPath: from the filesystem root every path is relative", () => {
  assertEquals(
    displayPath(join(ROOT, "tmp", "a.ts"), ROOT),
    join("tmp", "a.ts"),
  );
});

Deno.test("displayPath: a path that is not absolute is returned unchanged", () => {
  assertEquals(displayPath("(manifest)", CWD), "(manifest)");
  assertEquals(displayPath(join("a", "b.ts"), CWD), join("a", "b.ts"));
});

Deno.test({
  name: "displayPath: a file on another Windows drive prints absolute",
  ignore: SEPARATOR !== "\\",
  fn: () => {
    assertEquals(displayPath("D:\\work\\a.ts", "C:\\work"), "D:\\work\\a.ts");
  },
});

Deno.test("displayPath: the printed path resolves back to the file from cwd", () => {
  const file = join(ROOT, "home", "author", "other", "x.ts");
  assertEquals(resolve(CWD, displayPath(file, CWD)), file);
});
