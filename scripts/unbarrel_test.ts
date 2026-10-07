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

import { assertEquals, assertThrows } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  type BarrelExports,
  collectFiles,
  findModuleReferences,
  parseBarrel,
  rewriteSource,
  unbarrel,
} from "./unbarrel.ts";

const ROOT = resolve("repo");
const BARREL = join(ROOT, "src", "lib", "mod.ts");
const COMMAND = join(ROOT, "src", "cli", "commands", "thing.ts");

const BARREL_SOURCE = `
export { run, type RunInput } from "./ops/run.ts";
export type { RunEvent } from "./ops/run.ts";
export { stop } from "./ops/stop.ts";
export { internalName as publicName } from "./ops/renamed.ts";
export { evaluate } from "cel-js";
export { Shape } from "../domain/shape.ts";
`;

function barrel(): BarrelExports {
  return parseBarrel(BARREL, BARREL_SOURCE);
}

function rewrite(source: string, filePath = COMMAND) {
  return rewriteSource(filePath, source, BARREL, barrel());
}

Deno.test("parseBarrel: maps each exported name to the module it comes from", () => {
  const exports = barrel();

  assertEquals(exports.size, 7);
  assertEquals(exports.get("run"), {
    module: join(ROOT, "src", "lib", "ops", "run.ts"),
    bare: false,
    name: "run",
    typeOnly: false,
  });
  assertEquals(exports.get("Shape")?.module, join(ROOT, "src", "domain", "shape.ts"));
});

Deno.test("parseBarrel: records a rename under the public name", () => {
  const origin = barrel().get("publicName");

  assertEquals(origin?.name, "internalName");
  assertEquals(barrel().has("internalName"), false);
});

Deno.test("parseBarrel: marks inline and statement-level type exports", () => {
  const exports = barrel();

  assertEquals(exports.get("RunInput")?.typeOnly, true);
  assertEquals(exports.get("RunEvent")?.typeOnly, true);
  assertEquals(exports.get("run")?.typeOnly, false);
});

Deno.test("parseBarrel: keeps a bare specifier verbatim", () => {
  assertEquals(barrel().get("evaluate"), {
    module: "cel-js",
    bare: true,
    name: "evaluate",
    typeOnly: false,
  });
});

Deno.test("parseBarrel: rejects a barrel with no single origin per name", () => {
  assertThrows(
    () => parseBarrel(BARREL, `export * from "./ops/run.ts";`),
    Error,
    "ExportAllDeclaration",
  );
  assertThrows(
    () => parseBarrel(BARREL, `export * as ops from "./ops/run.ts";`),
    Error,
    "whole module",
  );
  assertThrows(
    () => parseBarrel(BARREL, `export const local = 1;`),
    Error,
    "may only contain",
  );
});

Deno.test("rewriteSource: groups names by the module that exports them", () => {
  const result = rewrite(
    `import { run, stop, Shape } from "../../lib/mod.ts";\nrun();\n`,
  );

  assertEquals(
    result.text,
    `import { run } from "../../lib/ops/run.ts";\n` +
      `import { stop } from "../../lib/ops/stop.ts";\n` +
      `import { Shape } from "../../domain/shape.ts";\nrun();\n`,
  );
  assertEquals(result.rewritten, 1);
  assertEquals(result.unhandled, []);
});

Deno.test("rewriteSource: writes a same-directory origin with a ./ prefix", () => {
  const result = rewrite(
    `import { stop } from "./mod.ts";\n`,
    join(ROOT, "src", "lib", "sibling.ts"),
  );

  assertEquals(result.text, `import { stop } from "./ops/stop.ts";\n`);
});

Deno.test("rewriteSource: imports a renamed export under its origin name", () => {
  assertEquals(
    rewrite(`import { publicName } from "../../lib/mod.ts";\n`).text,
    `import { internalName as publicName } from "../../lib/ops/renamed.ts";\n`,
  );
});

Deno.test("rewriteSource: keeps the importer's own alias", () => {
  assertEquals(
    rewrite(
      `import { publicName as mine, run as go } from "../../lib/mod.ts";\n`,
    ).text,
    `import { internalName as mine } from "../../lib/ops/renamed.ts";\n` +
      `import { run as go } from "../../lib/ops/run.ts";\n`,
  );
});

Deno.test("rewriteSource: keeps a statement-level type modifier", () => {
  assertEquals(
    rewrite(`import type { RunEvent, Shape } from "../../lib/mod.ts";\n`).text,
    `import type { RunEvent } from "../../lib/ops/run.ts";\n` +
      `import type { Shape } from "../../domain/shape.ts";\n`,
  );
});

Deno.test("rewriteSource: keeps inline type modifiers in a mixed import", () => {
  assertEquals(
    rewrite(
      `import { run, type RunEvent, type Shape } from "../../lib/mod.ts";\n`,
    ).text,
    `import { run, type RunEvent } from "../../lib/ops/run.ts";\n` +
      `import type { Shape } from "../../domain/shape.ts";\n`,
  );
});

Deno.test("rewriteSource: a name the barrel exports as a type stays a type", () => {
  // Through the barrel `RunInput` could only ever be a type, whatever the
  // importer wrote. Importing it bare from its origin would turn a type-only
  // edge into a runtime one.
  assertEquals(
    rewrite(`import { RunInput, stop } from "../../lib/mod.ts";\n`).text,
    `import type { RunInput } from "../../lib/ops/run.ts";\n` +
      `import { stop } from "../../lib/ops/stop.ts";\n`,
  );
});

Deno.test("rewriteSource: keeps a bare specifier", () => {
  assertEquals(
    rewrite(`import { evaluate, run } from "../../lib/mod.ts";\n`).text,
    `import { evaluate } from "cel-js";\n` +
      `import { run } from "../../lib/ops/run.ts";\n`,
  );
});

Deno.test("rewriteSource: rewrites export … from, keeping the exported name", () => {
  const result = rewrite(
    `export { publicName, run as go, type RunEvent } from "../../lib/mod.ts";\n` +
      `export type { Shape } from "../../lib/mod.ts";\n`,
  );

  assertEquals(
    result.text,
    `export { internalName as publicName } from "../../lib/ops/renamed.ts";\n` +
      `export { run as go, type RunEvent } from "../../lib/ops/run.ts";\n` +
      `export type { Shape } from "../../domain/shape.ts";\n`,
  );
  assertEquals(result.rewritten, 2);
});

Deno.test("rewriteSource: rewrites a type-position import()", () => {
  const result = rewrite(
    `let a: import("../../lib/mod.ts").RunEvent[] = [];\n` +
      `let b = x as import("../../lib/mod.ts").publicName.Inner<string>;\n`,
  );

  assertEquals(
    result.text,
    `let a: import("../../lib/ops/run.ts").RunEvent[] = [];\n` +
      `let b = x as import("../../lib/ops/renamed.ts").internalName.Inner<string>;\n`,
  );
  assertEquals(result.rewritten, 2);
});

Deno.test("rewriteSource: rewrites a multi-line import in a .tsx file", () => {
  const result = rewrite(
    `import {\n  run,\n  stop,\n} from "../../lib/mod.ts";\n` +
      `export const View = () => <Box onPress={run}>{stop}</Box>;\n`,
    join(ROOT, "src", "cli", "commands", "view.tsx"),
  );

  assertEquals(
    result.text,
    `import { run } from "../../lib/ops/run.ts";\n` +
      `import { stop } from "../../lib/ops/stop.ts";\n` +
      `export const View = () => <Box onPress={run}>{stop}</Box>;\n`,
  );
});

Deno.test("rewriteSource: leaves imports of other modules alone", () => {
  const source = `import { run } from "../../lib/ops/run.ts";\n` +
    `import { other } from "../../other/mod.ts";\n` +
    `import { z } from "zod";\n` +
    `const text = 'import { run } from "../../lib/mod.ts";';\n`;

  const result = rewrite(source);

  assertEquals(result.text, source);
  assertEquals(result.rewritten, 0);
  assertEquals(result.unhandled, []);
});

Deno.test("rewriteSource: is idempotent", () => {
  const once = rewrite(
    `import { run, type RunEvent, publicName } from "../../lib/mod.ts";\n` +
      `export { stop } from "../../lib/mod.ts";\n` +
      `let a: import("../../lib/mod.ts").Shape;\n`,
  );
  const twice = rewrite(once.text);

  assertEquals(once.rewritten, 3);
  assertEquals(twice.text, once.text);
  assertEquals(twice.rewritten, 0);
});

Deno.test("rewriteSource: reports references that take the whole barrel", () => {
  const source = `import * as lib from "../../lib/mod.ts";\n` +
    `import lib2 from "../../lib/mod.ts";\n` +
    `import "../../lib/mod.ts";\n` +
    `export * from "../../lib/mod.ts";\n` +
    `export * as ns from "../../lib/mod.ts";\n` +
    `const lazy = await import("../../lib/mod.ts");\n` +
    `type All = typeof import("../../lib/mod.ts");\n`;

  const result = rewrite(source);

  assertEquals(result.text, source);
  assertEquals(result.rewritten, 0);
  assertEquals(result.unhandled.map((u) => u.line), [1, 2, 3, 4, 5, 6, 7]);
  assertEquals(result.unhandled.map((u) => u.reason), [
    "ImportNamespaceSpecifier takes the whole barrel",
    "ImportDefaultSpecifier takes the whole barrel",
    "side-effect import of the barrel",
    "export * takes the whole barrel",
    "ExportNamespaceSpecifier takes the whole barrel",
    "dynamic import of the barrel",
    "import() type takes the whole barrel",
  ]);
});

Deno.test("rewriteSource: leaves a statement naming something the barrel lacks", () => {
  const source = `import { run, missing } from "../../lib/mod.ts";\n` +
    `let a: import("../../lib/mod.ts").AlsoMissing;\n`;

  const result = rewrite(source);

  assertEquals(result.text, source);
  assertEquals(result.unhandled, [
    { line: 1, reason: "missing is not exported by the barrel" },
    { line: 2, reason: "AlsoMissing is not exported by the barrel" },
  ]);
});

Deno.test("rewriteSource: leaves an import whose comment it would drop", () => {
  const source =
    `import {\n  // deno-lint-ignore no-unused-vars\n  run,\n} from "../../lib/mod.ts";\n`;

  const result = rewrite(source);

  assertEquals(result.text, source);
  assertEquals(result.unhandled, [
    { line: 1, reason: "comment inside the import would be lost" },
  ]);
});

Deno.test("findModuleReferences: reports each kind with origin-side names", () => {
  const references = findModuleReferences(
    COMMAND,
    `import { a as b, type C } from "./x.ts";\n` +
      `import d, * as ns from "./y.ts";\n` +
      `import "./side.ts";\n` +
      `export { e as f } from "./z.ts";\n` +
      `export * from "./all.ts";\n` +
      `export * as g from "./ns.ts";\n` +
      `type T = import("./t.ts").Outer.Inner;\n` +
      `type M = typeof import("./m.ts");\n` +
      `const lazy = () => import("./lazy.ts");\n`,
  );

  assertEquals(
    references.map((r) => [r.line, r.kind, r.specifier, r.names]),
    [
      [1, "import", "./x.ts", ["a", "C"]],
      [2, "default", "./y.ts", []],
      [2, "namespace", "./y.ts", []],
      [3, "side-effect", "./side.ts", []],
      [4, "export", "./z.ts", ["e"]],
      [5, "export-all", "./all.ts", []],
      [6, "namespace", "./ns.ts", []],
      [7, "import-type", "./t.ts", ["Outer"]],
      [8, "import-type-module", "./m.ts", []],
      [9, "dynamic", "./lazy.ts", []],
    ],
  );
});

async function withRepo(
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "src", "lib", "ops"), { recursive: true });
    await Deno.mkdir(join(root, "src", "cli"), { recursive: true });
    await Deno.mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await Deno.writeTextFile(join(root, "src", "lib", "mod.ts"), BARREL_SOURCE);
    await Deno.writeTextFile(
      join(root, "src", "cli", "thing.ts"),
      `import { run, type RunEvent } from "../lib/mod.ts";\n`,
    );
    await Deno.writeTextFile(
      join(root, "src", "cli", "lazy.ts"),
      `export const lib = await import("../lib/mod.ts");\n`,
    );
    await Deno.writeTextFile(
      join(root, "src", "cli", "untouched.ts"),
      `import { z } from "zod";\n`,
    );
    await Deno.writeTextFile(
      join(root, "node_modules", "dep", "index.ts"),
      `import { run } from "../../src/lib/mod.ts";\n`,
    );
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("collectFiles: walks the repository but not vendored or VCS directories", async () => {
  await withRepo(async (root) => {
    assertEquals(await collectFiles(root), [
      join(root, "src", "cli", "lazy.ts"),
      join(root, "src", "cli", "thing.ts"),
      join(root, "src", "cli", "untouched.ts"),
      join(root, "src", "lib", "mod.ts"),
    ]);
  });
});

Deno.test("unbarrel: rewrites importers, leaves the barrel, reports the rest", async () => {
  await withRepo(async (root) => {
    const barrelPath = join("src", "lib", "mod.ts");

    const summary = await unbarrel(root, barrelPath, { write: true });

    assertEquals(summary.changedFiles, [join("src", "cli", "thing.ts")]);
    assertEquals(summary.rewritten, 1);
    assertEquals(summary.barrelNames, 7);
    assertEquals(summary.unhandled, [
      `${join("src", "cli", "lazy.ts")}:1: dynamic import of the barrel`,
    ]);
    assertEquals(
      await Deno.readTextFile(join(root, "src", "cli", "thing.ts")),
      `import { run, type RunEvent } from "../lib/ops/run.ts";\n`,
    );
    assertEquals(
      await Deno.readTextFile(join(root, barrelPath)),
      BARREL_SOURCE,
    );

    const again = await unbarrel(root, barrelPath, { write: true });
    assertEquals(again.changedFiles, []);
    assertEquals(again.rewritten, 0);
  });
});

Deno.test("unbarrel: a check run reports the change without writing it", async () => {
  await withRepo(async (root) => {
    const original = await Deno.readTextFile(
      join(root, "src", "cli", "thing.ts"),
    );

    const summary = await unbarrel(root, join("src", "lib", "mod.ts"), {
      write: false,
    });

    assertEquals(summary.changedFiles, [join("src", "cli", "thing.ts")]);
    assertEquals(
      await Deno.readTextFile(join(root, "src", "cli", "thing.ts")),
      original,
    );
  });
});
