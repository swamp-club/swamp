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
import { dirname, join, relative } from "@std/path";
import fc from "fast-check";
import { createTarGz, extractTarGz } from "./tar_archive.ts";

/**
 * A small file tree: relative path → contents. Directory and file names use
 * disjoint prefixes so a path is never both a file and a directory.
 */
const arbTree = fc
  .array(
    fc.record({
      dir: fc.option(fc.constantFrom("da", "db", join("da", "dc")), {
        nil: undefined,
      }),
      name: fc.constantFrom("f1.txt", "f2.bin", "f3"),
      content: fc.uint8Array({ maxLength: 4096 }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((files) => {
    const tree = new Map<string, Uint8Array>();
    for (const f of files) {
      tree.set(f.dir ? join(f.dir, f.name) : f.name, f.content);
    }
    return tree;
  });

/** Path → contents and (on POSIX, where chmod applies) permission bits. */
async function readTree(
  root: string,
): Promise<Map<string, { content: Uint8Array; mode: number | null }>> {
  const tree = new Map<string, { content: Uint8Array; mode: number | null }>();
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) await walk(path);
      else {
        const mode = Deno.build.os === "windows"
          ? null
          : (await Deno.stat(path)).mode! & 0o7777;
        tree.set(relative(root, path), {
          content: await Deno.readFile(path),
          mode,
        });
      }
    }
  }
  await walk(root);
  return tree;
}

function sorted<T>(tree: Map<string, T>): [string, T][] {
  return [...tree].sort(([a], [b]) => a.localeCompare(b));
}

Deno.test("extractTarGz: a limit at or above the decompressed size yields the same tree as no limit", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbTree,
      fc.nat({ max: 4096 }),
      async (tree, slack) => {
        const tmp = await Deno.makeTempDir({ prefix: "tar-prop-" });
        try {
          const top = join(tmp, "src", "ext");
          await ensureDir(top);
          for (const [path, content] of tree) {
            await ensureDir(dirname(join(top, path)));
            await Deno.writeFile(join(top, path), content);
          }
          const archive = join(tmp, "a.tar.gz");
          await createTarGz(top, archive);
          const bytes = await Deno.readFile(archive);
          const decompressedLength = (await new Response(
            new Blob([bytes]).stream().pipeThrough(
              new DecompressionStream("gzip"),
            ),
          ).bytes()).byteLength;

          const unlimited = join(tmp, "unlimited");
          await extractTarGz(new Blob([bytes]).stream(), unlimited);
          const limited = join(tmp, "limited");
          await extractTarGz(new Blob([bytes]).stream(), limited, undefined, {
            maxDecompressedBytes: decompressedLength + slack,
          });

          const expected = sorted(await readTree(unlimited));
          assertEquals(sorted(await readTree(limited)), expected);
          assertEquals(expected.length, tree.size);
        } finally {
          await Deno.remove(tmp, { recursive: true }).catch(() => {});
        }
      },
    ),
    { numRuns: 25 },
  );
});
