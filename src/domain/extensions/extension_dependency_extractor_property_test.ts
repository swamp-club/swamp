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

// An import map only adds the bare imports it resolves (swamp-club#3611): a
// module that writes every dependency out audits exactly what it audited
// before the audit read the map, whatever the map holds.

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  extractSpecifiersFromSource,
  importMapResolver,
} from "./extension_dependency_extractor.ts";

const writtenImportArb = fc.constantFrom(
  'import a from "npm:axios@1.7.2";',
  'import { parse } from "jsr:@std/semver@1.0.8";',
  'export { x } from "npm:@aws-sdk/client-s3@3.600.0";',
  'import "npm:side-effect@^2";',
  'const m = await import("npm:lazy@1.0.0");',
  'import { util } from "./utils/mod.ts";',
  'import { join } from "node:path";',
  "// a comment",
  'const s = `import c from "c";`;',
);
const keyArb = fc.constantFrom(
  "ms",
  "axios",
  "@std/path",
  "preact/",
  "c",
  "npm:axios@1.7.2",
);
const targetArb = fc.constantFrom(
  "npm:ms@2.1.3",
  "npm:axios@0.1.0",
  "jsr:@std/path@^1",
  "npm:/preact@10.27.3/",
  "./local.ts",
  "https://esm.sh/x@1",
);

Deno.test("extractSpecifiersFromSource: any import map leaves written imports' results unchanged", () => {
  fc.assert(
    fc.property(
      fc.array(writtenImportArb, { maxLength: 8 }),
      fc.dictionary(keyArb, targetArb),
      (lines, imports) => {
        const source = lines.join("\n");
        assertEquals(
          extractSpecifiersFromSource(
            source,
            "model.ts",
            importMapResolver(imports),
          ),
          extractSpecifiersFromSource(source, "model.ts"),
        );
      },
    ),
  );
});
