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
import { walk } from "@std/fs";
import { fromFileUrl } from "@std/path";
import {
  extractImports,
  isUnder,
  repoRelative,
  resolveImport,
} from "./arch_fitness_helpers.ts";

const PACKAGE = fromFileUrl(new URL("../packages/client/", import.meta.url));

Deno.test("client package rules: published files import only from inside packages/client", async () => {
  const offenders: string[] = [];
  for await (
    const entry of walk(PACKAGE, { exts: [".ts"], skip: [/_test\.ts$/] })
  ) {
    const source = await Deno.readTextFile(entry.path);
    for (const specifier of extractImports(source)) {
      // the module docs' examples import the package by its own name
      if (specifier === "@swamp-club/swamp-lib") continue;
      const target = resolveImport(entry.path, specifier);
      if (target === undefined || !isUnder(target, "packages/client")) {
        offenders.push(`${repoRelative(entry.path)} -> ${specifier}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "swamp-lib publishes on its own: copy a type into packages/client rather than importing it",
  );
});
