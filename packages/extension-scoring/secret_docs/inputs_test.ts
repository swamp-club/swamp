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
import { importedSpecifiersAt } from "../source/imports.ts";
import { markdownImports, markdownImportsFromSites } from "./inputs.ts";

Deno.test("markdownImportsFromSites: resolves relative Markdown imports from the sites", () => {
  const path = "models/aws/m.ts";
  const source = [
    'import a from "./a.md" with { type: "text" };',
    'import b from "../shared/B.MD" with { type: "text" };',
    'import c from "npm:c@1";',
    'import d from "./d.ts";',
    'import e from "/abs/e.md" with { type: "text" };',
    'import f from "../../../out.md" with { type: "text" };',
  ].join("\n");
  const sites = importedSpecifiersAt(source, { path });
  assertEquals(markdownImportsFromSites(path, sites), [
    "models/aws/a.md",
    "models/shared/B.MD",
  ]);
  assertEquals(
    markdownImportsFromSites(path, sites),
    markdownImports(path, source),
  );
});

Deno.test("markdownImportsFromSites: none for a module that does not parse", () => {
  assertEquals(markdownImportsFromSites("models/m.ts", null), []);
});
