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
import {
  BundleModuleMap,
  dependencyLabel,
  isDependencyModulePath,
} from "./bundle_module_map.ts";
import { parseExtensionSourceWithComments } from "./extension_source_ast.ts";

/** The map of `source`, read from its parsed comments. */
function parsedMap(source: string): BundleModuleMap {
  const parsed = parseExtensionSourceWithComments(source);
  if (!parsed) throw new Error("fixture does not parse");
  return BundleModuleMap.fromComments(parsed.comments);
}

const BUNDLE = [
  "var __defProp = Object.defineProperty;", // 1: prelude
  "// ../../.swamp/deno-cache/npm/registry.npmjs.org/zod/4.3.6/v4/core/util.js",
  "const a = 1;", // 3
  "// @__NO_SIDE_EFFECTS__",
  "const b = 2;", // 5
  "// extensions/models/_lib/helper.ts",
  "const c = 3;", // 7
  "// compose.ts",
  "const d = 4;", // 9
].join("\n");

Deno.test("BundleModuleMap.moduleAt: attributes each line to the comment above it", () => {
  for (const map of [parsedMap(BUNDLE), BundleModuleMap.fromText(BUNDLE)]) {
    assertEquals(map.moduleCount, 3);
    assertEquals(map.moduleAt(1), { origin: "unattributed" });
    assertEquals(map.moduleAt(3), {
      path:
        "../../.swamp/deno-cache/npm/registry.npmjs.org/zod/4.3.6/v4/core/util.js",
      origin: "dependency",
    });
    // A comment that names no module does not start one.
    assertEquals(map.moduleAt(5).origin, "dependency");
    assertEquals(map.moduleAt(7), {
      path: "extensions/models/_lib/helper.ts",
      origin: "author",
    });
    assertEquals(map.moduleAt(9), { path: "compose.ts", origin: "author" });
  }
});

Deno.test("BundleModuleMap.moduleAt: a module path with spaces starts a module, so the dependency above does not claim its code", () => {
  const source = [
    "// ../.swamp/deno-cache/npm/registry.npmjs.org/dep/1.0.0/index.js",
    "const a = 1;",
    "// .swamp/pulled-extensions/@x/y/files/sub dir/evil helper.js",
    "const b = 2;", // 4
  ].join("\n");
  for (const map of [parsedMap(source), BundleModuleMap.fromText(source)]) {
    assertEquals(map.moduleAt(4), {
      path: ".swamp/pulled-extensions/@x/y/files/sub dir/evil helper.js",
      origin: "author",
    });
  }
});

Deno.test("BundleModuleMap.moduleAt: a bundle without module comments is unattributed throughout", () => {
  const map = parsedMap("const x = 1;\nconst y = 2;\n");
  assertEquals(map.moduleCount, 0);
  assertEquals(map.moduleAt(2), { origin: "unattributed" });
});

Deno.test("BundleModuleMap.fromComments: a comment-like line inside a template literal starts no module", () => {
  const source = [
    "// extensions/models/thing.ts",
    "const text = `",
    "// ../.swamp/deno-cache/npm/registry.npmjs.org/dep/1.0.0/index.js",
    "`;",
    "const run = 1;", // 5
  ].join("\n");
  assertEquals(parsedMap(source).moduleAt(5), {
    path: "extensions/models/thing.ts",
    origin: "author",
  });
  // Only a bundle that does not parse is read line by line.
  assertEquals(
    BundleModuleMap.fromText(source).moduleAt(5).origin,
    "dependency",
  );
});

Deno.test("BundleModuleMap.fromComments: an indented or block comment starts no module", () => {
  const source = [
    "// extensions/models/thing.ts",
    "  // ../node_modules/dep/index.js",
    "/* ../node_modules/dep/index.js */",
    "const run = 1;", // 4
  ].join("\n");
  assertEquals(parsedMap(source).moduleAt(4).origin, "author");
});

Deno.test("isDependencyModulePath: recognizes cache, node_modules and remote paths", () => {
  for (
    const path of [
      "../../.swamp/deno-cache/npm/registry.npmjs.org/zod/4.3.6/v4/core/util.js",
      "../../../Library/Caches/deno/npm/registry.npmjs.org/a/1.0.0/index.js",
      "../../.cache/deno/remote/https/deno.land/std/path/mod.ts",
      "node_modules/.deno/ajv@8.18.0/node_modules/ajv/dist/compile/index.js",
      "..\\..\\Users\\me\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\a\\1.0.0\\i.js",
      "deno:https://jsr.io/@deno/graph/0.111.0/deno_graph_wasm.internal.js",
      "https://esm.sh/lodash@4.17.21",
      "npm:zod@4",
    ]
  ) {
    assertEquals(isDependencyModulePath(path), true, path);
  }
  for (
    const path of [
      "extensions/models/thing.ts",
      "../../home/alice/repo/extensions/models/_lib/npm/client.ts",
      ".swamp/pulled-extensions/@swamp/git/models/_lib/runner.ts",
      "compose.ts",
    ]
  ) {
    assertEquals(isDependencyModulePath(path), false, path);
  }
});

Deno.test("dependencyLabel: names a dependency without the machine it was bundled on", () => {
  assertEquals(
    dependencyLabel(
      "../../../Users/me/.swamp/deno-cache/npm/registry.npmjs.org/zod/4.3.6/v4/core/util.js",
    ),
    "npm:zod/4.3.6/v4/core/util.js",
  );
  assertEquals(
    dependencyLabel(
      "..\\AppData\\Local\\deno\\npm\\registry.npmjs.org\\a\\1.0.0\\i.js",
    ),
    "npm:a/1.0.0/i.js",
  );
  assertEquals(
    dependencyLabel(
      "node_modules/.deno/ajv@8.18.0/node_modules/ajv/dist/compile/index.js",
    ),
    "npm:ajv/dist/compile/index.js",
  );
  assertEquals(
    dependencyLabel("../.cache/deno/remote/https/deno.land/std/path/mod.ts"),
    "https://deno.land/std/path/mod.ts",
  );
  assertEquals(
    dependencyLabel("deno:https://jsr.io/@deno/graph/0.111.0/x.js"),
    "https://jsr.io/@deno/graph/0.111.0/x.js",
  );
});
