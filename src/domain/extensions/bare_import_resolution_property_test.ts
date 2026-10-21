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
import { join } from "@std/path";
import fc from "fast-check";
import {
  bareImportResolverFrom,
  type ResolvedBareImport,
} from "./bare_import_resolution.ts";

const ROOT = Deno.build.os === "windows" ? "C:\\ext" : "/ext";

const resolutionArb: fc.Arbitrary<ResolvedBareImport> = fc.record({
  importer: fc.constantFrom("a.ts", "b.ts", "lib/c.ts", "models/d.ts")
    .map((p) => join(ROOT, p)),
  specifier: fc.constantFrom("ms", "zod", "@std/path", "@std/path/posix"),
  target: fc.option(
    fc.constantFrom("npm:ms@2.1.2", "npm:ms@3.0.0", "npm:zod@4", "node:fs"),
    { nil: undefined },
  ),
}).map((r) =>
  r.target === undefined ? { importer: r.importer, specifier: r.specifier } : r
);

Deno.test("bareImportResolverFrom: answers exactly the first recorded target for each importer and specifier, and nothing else", () => {
  fc.assert(
    fc.property(
      fc.array(resolutionArb, { maxLength: 20 }),
      resolutionArb,
      (resolutions, probe) => {
        const resolver = bareImportResolverFrom(resolutions);
        const first = resolutions.find((r) =>
          r.importer === probe.importer && r.specifier === probe.specifier
        );
        assertEquals(
          resolver.resolve(probe.importer, probe.specifier),
          first?.target,
        );
      },
    ),
  );
});
