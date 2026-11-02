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

import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join, relative } from "@std/path";
import fc from "fast-check";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { DefinitionIdIndex } from "./definition_id_index.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";

const IDS = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const TYPE_DIRS = ["test/a", "test/b", "test/a/nested"];
const FILES = ["one.yaml", "two.yaml", "three.yaml"];
const NAMES = ["one", "two", "shared"];

let clock = Date.UTC(2020, 0, 1);

async function bumpUpTo(root: string, path: string): Promise<void> {
  for (let p = path;; p = dirname(p)) {
    clock += 1_000;
    await Deno.utime(p, new Date(clock), new Date(clock)).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    if (p === root || relative(root, p).startsWith("..")) return;
  }
}

function yamlOf(id: string, name: string, tag: string): string {
  return `id: ${id}\nname: ${name}\nversion: 1\ntags:\n  tag: ${tag}\n`;
}

type Op =
  | {
    kind: "write";
    root: number;
    typeDir: string;
    file: string;
    id: string;
    name: string;
    tag: string;
  }
  | { kind: "break"; root: number; typeDir: string; file: string }
  | { kind: "retag"; root: number; typeDir: string; file: string; tag: string }
  | { kind: "remove"; root: number; typeDir: string; file: string }
  | { kind: "removeDir"; root: number; typeDir: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("write" as const),
    root: fc.nat(1),
    typeDir: fc.constantFrom(...TYPE_DIRS),
    file: fc.constantFrom(...FILES),
    id: fc.constantFrom(...IDS),
    name: fc.constantFrom(...NAMES),
    tag: fc.constantFrom("x", "y"),
  }),
  fc.record({
    kind: fc.constant("break" as const),
    root: fc.nat(1),
    typeDir: fc.constantFrom(...TYPE_DIRS),
    file: fc.constantFrom(...FILES),
  }),
  fc.record({
    kind: fc.constant("retag" as const),
    root: fc.nat(1),
    typeDir: fc.constantFrom(...TYPE_DIRS),
    file: fc.constantFrom(...FILES),
    tag: fc.constantFrom("x", "y", "z"),
  }),
  fc.record({
    kind: fc.constant("remove" as const),
    root: fc.nat(1),
    typeDir: fc.constantFrom(...TYPE_DIRS),
    file: fc.constantFrom(...FILES),
  }),
  fc.record({
    kind: fc.constant("removeDir" as const),
    root: fc.nat(1),
    typeDir: fc.constantFrom(...TYPE_DIRS),
  }),
);

async function apply(roots: string[], op: Op): Promise<void> {
  const root = roots[op.root];
  const dir = join(root, op.typeDir);
  switch (op.kind) {
    case "write": {
      const path = join(dir, op.file);
      await ensureDir(dir);
      await Deno.writeTextFile(`${path}.tmp`, yamlOf(op.id, op.name, op.tag));
      await Deno.rename(`${path}.tmp`, path);
      await bumpUpTo(root, path);
      return;
    }
    case "break": {
      const path = join(dir, op.file);
      await ensureDir(dir);
      await Deno.writeTextFile(`${path}.tmp`, "id: [unclosed\n");
      await Deno.rename(`${path}.tmp`, path);
      await bumpUpTo(root, path);
      return;
    }
    case "retag": {
      const path = join(dir, op.file);
      let content: string;
      try {
        content = await Deno.readTextFile(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      await Deno.writeTextFile(
        path,
        content.replace(/tag: .*/, `tag: ${op.tag}`),
      );
      clock += 1_000;
      await Deno.utime(path, new Date(clock), new Date(clock));
      return;
    }
    case "remove": {
      try {
        await Deno.remove(join(dir, op.file));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      await bumpUpTo(root, dir);
      return;
    }
    case "removeDir": {
      try {
        await Deno.remove(dir, { recursive: true });
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      await bumpUpTo(root, dirname(dir));
      return;
    }
  }
}

function describe(
  found: {
    definition: { name: string; tags: Record<string, string> };
    type: { normalized: string };
  }[],
) {
  return found.map((
    f,
  ) => [f.type.normalized, f.definition.name, f.definition.tags]);
}

// swept: the clock passes the reverify interval before each round, so every
// kept file is stat'ed; unswept: only a lookup by id that misses stats them;
// fixed: the clock stands still, for stats that must stay too recent
type Sweep = "swept" | "unswept" | "fixed";

const REVERIFY_INTERVAL_MS = 30_000;

/**
 * rewriting a name-derived file to declare another name is the documented gap:
 * save() writes a renamed definition to another file instead
 */
function isDocumentedGap(
  roots: string[],
  op: Op,
  declared: Map<string, string | undefined>,
): boolean {
  if (op.kind !== "write") return false;
  const path = join(roots[op.root], op.typeDir, op.file);
  const name = declared.get(path);
  return name !== undefined && op.file === `${name}.yaml` && op.name !== name;
}

function track(
  roots: string[],
  op: Op,
  declared: Map<string, string | undefined>,
): void {
  const dir = join(roots[op.root], op.typeDir);
  if (op.kind === "write") declared.set(join(dir, op.file), op.name);
  else if (op.kind === "break") declared.set(join(dir, op.file), undefined);
  else if (op.kind === "remove") declared.delete(join(dir, op.file));
  else if (op.kind === "removeDir") {
    for (const path of [...declared.keys()]) {
      if (path === dir || !relative(dir, path).startsWith("..")) {
        declared.delete(path);
      }
    }
  }
}

async function assertMatchesScan(
  clockAhead: number,
  numRuns: number,
  sweep: Sweep = "swept",
) {
  await fc.assert(
    fc.asyncProperty(
      fc.array(opArb, { minLength: 1, maxLength: 12 }),
      async (ops) => {
        const dir = await Deno.makeTempDir();
        try {
          const roots = [
            join(dir, "models"),
            join(dir, ".swamp", "auto-definitions"),
          ];
          const repo = new YamlDefinitionRepository(
            dir,
            undefined,
            roots[0],
            roots[1],
          );
          let skew = 0;
          const index = new DefinitionIdIndex(repo, {
            now: () => Date.now() + clockAhead + skew,
          });
          const declared = new Map<string, string | undefined>();
          for (const op of ops) {
            if (sweep === "unswept" && isDocumentedGap(roots, op, declared)) {
              continue;
            }
            await apply(roots, op);
            track(roots, op, declared);
            if (sweep === "swept") skew += REVERIFY_INTERVAL_MS;
            const all = await repo.findAllIncludingAutoGlobal();
            const view = await index.begin();
            for (const id of IDS) {
              const expected = describe(
                all.filter((f) => f.definition.id === id),
              );
              // The second answers from what the first left behind.
              for (let lookup = 0; lookup < 2; lookup++) {
                const owners = describe(
                  await view.findAllById(id as DefinitionId),
                );
                const found = describe(await index.findAllById(id));
                // Unswept, a kept file that now declares an id another file
                // declares is not found until the sweep: it fails open.
                if (sweep === "unswept" && expected.length > 1) {
                  const known = expected.map((e) => JSON.stringify(e));
                  for (const owner of [...owners, ...found]) {
                    assert(known.includes(JSON.stringify(owner)));
                  }
                  continue;
                }
                assertEquals(owners, expected);
                assertEquals(found, expected);
              }
            }
            for (const name of [...NAMES, "missing"]) {
              const found = await index.findByName(name);
              assertEquals(
                describe(found ? [found] : []),
                describe(
                  all.filter((f) => f.definition.name === name)
                    .slice(0, 1),
                ),
                name,
              );
            }
          }
        } finally {
          if (Deno.build.os === "windows") {
            // Best-effort: EBUSY can fire when V8 hasn't GC'd native
            // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
            await Deno.remove(dir, { recursive: true }).catch(() => {});
          } else {
            await Deno.remove(dir, { recursive: true });
          }
        }
      },
    ),
    { numRuns },
  );
}

Deno.test("DefinitionIdIndex: after any sequence of writes, removals and in-place edits, answers every id and name as a scan of every definition does", async () => {
  await assertMatchesScan(60_000, 50);
});

Deno.test("DefinitionIdIndex: without a sweep, answers every id a single file declares and every name as a scan does, a lookup by id that misses stating the kept files", async () => {
  await assertMatchesScan(60_000, 50, "unswept");
});

Deno.test("DefinitionIdIndex: answers as a scan does while every stat is too recent to trust", async () => {
  await assertMatchesScan(0, 20, "fixed");
});

Deno.test("DefinitionIdIndex: a regular file overwritten in place to declare another id is not an owner of it until its directory changes", async () => {
  // Left to the next listing of its directory, then found by a lookup by id
  // that misses or by the sweep; it fails open until then, see
  // DefinitionIdIndex. If this starts failing because it is seen at once, the
  // documented limit can be dropped.
  const dir = await Deno.makeTempDir();
  try {
    const roots = [
      join(dir, "models"),
      join(dir, ".swamp", "auto-definitions"),
    ];
    const repo = new YamlDefinitionRepository(
      dir,
      undefined,
      roots[0],
      roots[1],
    );
    const index = new DefinitionIdIndex(repo, {
      now: () => Date.now() + 60_000,
    });
    const id = IDS[0];
    const path = join(roots[0], "test", "a", "other.yaml");
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, yamlOf(crypto.randomUUID(), "other", "x"));
    await bumpUpTo(roots[0], path);
    assertEquals(
      await (await index.begin()).findAllById(id as DefinitionId),
      [],
    );

    await Deno.writeTextFile(path, yamlOf(id, "other", "x"));
    clock += 1_000;
    await Deno.utime(path, new Date(clock), new Date(clock));
    assertEquals(
      await (await index.begin()).findAllById(id as DefinitionId),
      [],
    );

    await bumpUpTo(roots[0], dirname(path));
    assertEquals(
      describe(await (await index.begin()).findAllById(id as DefinitionId)),
      [["test/a", "other", { tag: "x" }]],
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
