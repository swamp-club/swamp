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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import fc from "fast-check";
import { isFilenameSafeDefinitionName } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { AutoDefinitionNameIndex } from "./auto_definition_name_index.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";

const TYPE = ModelType.create("test/a");
const NAMES = ["alpha", "beta", "gamma", "Not Safe"];
const IDS: string[] = [
  crypto.randomUUID(),
  crypto.randomUUID(),
  crypto.randomUUID(),
];
const FILES = [
  "alpha.yaml",
  "beta.yaml",
  "gamma.yaml",
  ...IDS.map((id) => `${id}.yaml`),
];

let clock = Date.UTC(2020, 0, 1);

/** Gives `path` an mtime no earlier change has used. */
async function bump(path: string): Promise<void> {
  clock += 1_000;
  await Deno.utime(path, new Date(clock), new Date(clock));
}

type Op =
  | { kind: "add"; file: string; name: string }
  | { kind: "remove"; file: string }
  | { kind: "rewrite"; file: string; name: string }
  | { kind: "corrupt"; file: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("add" as const),
    file: fc.constantFrom(...FILES),
    name: fc.constantFrom(...NAMES),
  }),
  fc.record({
    kind: fc.constant("remove" as const),
    file: fc.constantFrom(...FILES),
  }),
  fc.record({
    kind: fc.constant("rewrite" as const),
    file: fc.constantFrom(...FILES),
    name: fc.constantFrom(...NAMES),
  }),
  fc.record({
    kind: fc.constant("corrupt" as const),
    file: fc.constantFrom(...FILES),
  }),
);

/** A file a lookup reads at its name-derived path, which the index leaves out. */
function isNameDerived(file: string, name: string | undefined): boolean {
  return name !== undefined && isFilenameSafeDefinitionName(name) &&
    file === `${name}.yaml`;
}

/**
 * What a full scan of the directory answers for `name` once its
 * name-derived file has missed: the first file in name order that declares
 * it, other than that file.
 */
function scan(files: Map<string, string | undefined>, name: string) {
  for (const file of [...files.keys()].sort()) {
    if (isNameDerived(file, name)) continue;
    if (files.get(file) === name) return file;
  }
  return null;
}

Deno.test("AutoDefinitionNameIndex: answers every name as a full scan does, across adds, removes and in-place rewrites", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(opArb, { minLength: 1, maxLength: 14 }),
      async (ops) => {
        const dir = await Deno.makeTempDir();
        try {
          const auto = join(dir, ".swamp", "auto-definitions");
          const typeDir = join(auto, TYPE.toDirectoryPath());
          await ensureDir(typeDir);
          const repo = new YamlDefinitionRepository(
            dir,
            undefined,
            join(dir, "models"),
            auto,
          );
          const index = new AutoDefinitionNameIndex(
            typeDir,
            TYPE,
            (path, segments, isSymlink) =>
              repo.readDefinitionFile(path, segments, isSymlink),
            { now: () => Date.now() + 60_000 },
          );
          // Each file's declared name; undefined for a broken file.
          const files = new Map<string, string | undefined>();
          for (const op of ops) {
            const path = join(typeDir, op.file);
            const present = files.has(op.file);
            if (op.kind === "add") {
              if (present) continue;
              await Deno.writeTextFile(path, yamlOf(op.file, op.name));
              await bump(path);
              await bump(typeDir);
              files.set(op.file, op.name);
            } else if (op.kind === "remove") {
              if (!present) continue;
              await Deno.remove(path);
              await bump(typeDir);
              files.delete(op.file);
            } else {
              // Rewriting a name-derived file to declare another name is the
              // documented gap: save() moves a renamed definition instead.
              if (!present || isNameDerived(op.file, files.get(op.file))) {
                continue;
              }
              const name = op.kind === "rewrite" ? op.name : undefined;
              await Deno.writeTextFile(
                path,
                name === undefined ? "id: [broken\n" : yamlOf(op.file, name),
              );
              await bump(path);
              files.set(op.file, name);
            }
            for (const name of NAMES) {
              const found = await index.find(name);
              const expected = scan(files, name);
              assertEquals(
                found === null ? null : found.path,
                expected === null ? null : join(typeDir, expected),
                `lookup of ${name} after ${JSON.stringify(op)}`,
              );
            }
          }
        } finally {
          await Deno.remove(dir, { recursive: true }).catch((error) => {
            if (Deno.build.os !== "windows") throw error;
          });
        }
      },
    ),
    { numRuns: 60 },
  );
});

/** A definition file's text; a uuid-named file keeps its id. */
function yamlOf(file: string, name: string): string {
  const stem = file.slice(0, -".yaml".length);
  const id = IDS.includes(stem) ? stem : crypto.randomUUID();
  return `id: ${id}\nname: ${name}\nversion: 1\n`;
}
