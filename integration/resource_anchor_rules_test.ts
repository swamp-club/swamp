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

/**
 * a bundled module's import.meta points at its chunk, not its source file, so
 * resource lookups go through src/infrastructure/runtime/resource_root.ts;
 * pinned by file, with recordDefiningModule allowed wherever it is called
 */

import { assertEquals } from "@std/assert";
import {
  assertPinnedSet,
  callArguments,
  countedKeys,
  isCommentLine,
  productionSourceFiles,
  repoRelative,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const PINNED = [
  "src/infrastructure/runtime/resource_root.ts",
  // Entry modules run under deno run; a compiled binary re-executes itself.
  "src/infrastructure/datastore_v3/litestream/litestream_replicator.ts",
  "src/infrastructure/runtime/process_bundle_prober.ts",
  "src/infrastructure/telemetry/telemetry_sender_process.ts",
  "src/worker/dispatch_handler.ts",
  // Test support, never part of a release build.
  "src/infrastructure/testing/subprocess_harness.ts",
];

const LOCATION_READ = /\bimport\.meta\.(?:url|dirname|filename|resolve)\b/g;
const DEFINING_MODULE_CALL = /\brecordDefiningModule\s*\(/g;

function lineAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? undefined : end);
}

function locationReadsOutsideAnchor(source: string): number {
  let reads = 0;
  for (const line of source.split("\n")) {
    if (isCommentLine(line)) continue;
    reads += line.match(LOCATION_READ)?.length ?? 0;
  }
  for (const call of source.matchAll(DEFINING_MODULE_CALL)) {
    if (isCommentLine(lineAt(source, call.index))) continue;
    const args = callArguments(source, call.index + call[0].length);
    if (args[1] === "import.meta.url") reads--;
  }
  return reads;
}

Deno.test("resource anchor: only pinned files in src read their own module location (swamp-club#4611)", async () => {
  const keys: string[] = [];
  for await (const file of productionSourceFiles(SRC_DIR)) {
    const reads = locationReadsOutsideAnchor(await Deno.readTextFile(file));
    for (let i = 0; i < reads; i++) keys.push(repoRelative(file));
  }
  assertPinnedSet(
    countedKeys(keys),
    PINNED,
    "Module-location reads outside the resource anchor",
    "A bundled build moves import.meta to the chunk, so a lookup relative to " +
      "it breaks. Find embedded resources with resourcePath() from " +
      "src/infrastructure/runtime/resource_root.ts. Pin a file here only " +
      "when it locates a module that never runs from a compiled binary.",
  );
});

Deno.test("resource anchor: a new import.meta.dirname lookup is reported", () => {
  const source = [
    `const dir = join(import.meta.dirname ?? ".", "..", "assets");`,
  ].join("\n");
  assertEquals(locationReadsOutsideAnchor(source), 1);
});

Deno.test("resource anchor: import.meta.filename and import.meta.resolve reads are reported", () => {
  const source = [
    "const file = import.meta.filename;",
    `const entry = import.meta.resolve("./entry.ts");`,
  ].join("\n");
  assertEquals(locationReadsOutsideAnchor(source), 2);
});

Deno.test("resource anchor: a recordDefiningModule call is allowed on one line or split across lines", () => {
  const source = [
    "export const a = recordDefiningModule(aCommand, import.meta.url);",
    "export function b() {",
    "  return recordDefiningModule(",
    "    new Command().action(() => {",
    "      run(1, 2);",
    "    }),",
    "    import.meta.url,",
    "  );",
    "}",
  ].join("\n");
  assertEquals(locationReadsOutsideAnchor(source), 0);
});

Deno.test("resource anchor: a mention of import.meta.url in a comment is ignored", () => {
  const source = [
    "/**",
    " * resolved against import.meta.url by the caller",
    " */",
    "// import.meta.dirname is the chunk directory when bundled",
    "export const x = 1;",
  ].join("\n");
  assertEquals(locationReadsOutsideAnchor(source), 0);
});

Deno.test("resource anchor: a recordDefiningModule call with another argument does not excuse a lookup", () => {
  const source = [
    "export const a = recordDefiningModule(aCommand, moduleUrl);",
    `const dir = join(import.meta.dirname ?? ".", "..");`,
  ].join("\n");
  assertEquals(locationReadsOutsideAnchor(source), 1);
});

Deno.test("resource anchor: two remaining reads in one file are keyed (x2)", () => {
  const reads = locationReadsOutsideAnchor([
    `const a = new URL("./a.ts", import.meta.url);`,
    `const b = new URL("./b.ts", import.meta.url);`,
  ].join("\n"));
  const keys = Array.from({ length: reads }, () => "src/x.ts");
  assertEquals(countedKeys(keys), ["src/x.ts (x2)"]);
});
